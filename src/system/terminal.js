import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import {
  checkRateLimit,
  formatRetryAfter,
  getDestructiveCommandReason,
  redactSecrets,
  truncateOutput,
  validateCommand
} from "../utils/security.js";
import {
  appendProcessOutput,
  findProcess,
  registerProcess,
  stopProcess
} from "./processManager.js";

async function appendCommandLog({ command, cwd, output, status, exitCode = null }) {
  const entry = [
    `\n[${new Date().toISOString()}] ${status}`,
    `cwd: ${cwd}`,
    `command: ${command}`,
    exitCode === null ? null : `exitCode: ${exitCode}`,
    "output:",
    redactSecrets(output || "")
  ]
    .filter(Boolean)
    .join("\n");

  await fs.appendFile(config.commandLogFile, `${entry}\n`, "utf8").catch((error) => {
    console.error("Gagal menulis command log:", error.message);
  });
}

function spawnSafe(executable, args, cwd, { detached = false } = {}) {
  // Pass as a single command string to avoid Windows array escaping issues with shell:true
  // and to avoid DEP0190 deprecation warning.
  const escapedArgs = args.map(a => /\s/.test(a) && !a.startsWith('"') && !a.startsWith("'") ? `"${a}"` : a);
  const fullCommand = [executable, ...escapedArgs].join(" ");
  
  return spawn(fullCommand, {
    cwd,
    shell: true,
    windowsHide: true,
    detached: detached && process.platform !== "win32",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1"
    }
  });
}

function terminateChild(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    }).once("error", () => {});
    return;
  }
  child.kill("SIGTERM");
}

export async function runCommand(command, projectDir, { userId = "admin", approved = false } = {}) {
  const rate = checkRateLimit(`command:${userId}`, config.commandRateLimit);
  if (!rate.allowed) {
    return {
      ok: false,
      output: `Rate limit aktif. Coba lagi dalam ${formatRetryAfter(rate.retryAfterMs)}.`
    };
  }

  let safeCommand;
  try {
    safeCommand = validateCommand(command, projectDir, { approved });
  } catch (error) {
    return { ok: false, output: error.message };
  }

  if (safeCommand.isLongRunning) {
    return startLongRunningCommand(safeCommand, projectDir);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnSafe(safeCommand.executable, safeCommand.args, projectDir);
    } catch (error) {
      const finalOutput = truncateOutput(`[spawn error] ${error.message}`);
      appendCommandLog({
        command: safeCommand.normalizedCommand,
        cwd: projectDir,
        output: finalOutput,
        status: "error"
      });
      resolve({ ok: false, output: finalOutput, command: safeCommand.normalizedCommand });
      return;
    }

    let output = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild(child);
      const finalOutput = truncateOutput(`${output}\n\n[timeout] Command dihentikan setelah ${config.commandTimeoutMs} ms.`);
      appendCommandLog({
        command: safeCommand.normalizedCommand,
        cwd: projectDir,
        output: finalOutput,
        status: "timeout"
      });
      resolve({ ok: false, output: finalOutput, command: safeCommand.normalizedCommand });
    }, config.commandTimeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.once("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const finalOutput = truncateOutput(`[spawn error] ${error.message}\n${output}`);
      await appendCommandLog({
        command: safeCommand.normalizedCommand,
        cwd: projectDir,
        output: finalOutput,
        status: "error"
      });
      resolve({ ok: false, output: finalOutput, command: safeCommand.normalizedCommand });
    });

    child.once("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const finalOutput = truncateOutput(output || "(command selesai tanpa output)");
      await appendCommandLog({
        command: safeCommand.normalizedCommand,
        cwd: projectDir,
        output: finalOutput,
        status: code === 0 ? "success" : "failed",
        exitCode: code
      });
      resolve({
        ok: code === 0,
        exitCode: code,
        output: finalOutput,
        command: safeCommand.normalizedCommand
      });
    });
  });
}

async function startLongRunningCommand(safeCommand, projectDir) {
  const existing = findProcess(safeCommand.processLabel || "dev-server");
  if (existing && existing.status === "running") {
    return {
      ok: false,
      output: `Process ${existing.label} masih berjalan (#${existing.id}, pid ${existing.pid}). Gunakan /stop atau /restart dulu.`
    };
  }

  // Long-running dev server dipertahankan sebagai process terlacak agar bisa dihentikan dari Telegram.
  let child;
  try {
    child = spawnSafe(safeCommand.executable, safeCommand.args, projectDir, { detached: true });
  } catch (error) {
    const finalOutput = truncateOutput(`[spawn error] ${error.message}`);
    await appendCommandLog({
      command: safeCommand.normalizedCommand,
      cwd: projectDir,
      output: finalOutput,
      status: "error"
    });
    return {
      ok: false,
      output: finalOutput,
      command: safeCommand.normalizedCommand
    };
  }

  const record = registerProcess({
    command: safeCommand.normalizedCommand,
    cwd: projectDir,
    label: safeCommand.processLabel || "long-running",
    child,
    longRunning: true
  });

  await logger.info("Long running command dimulai", {
    id: record.id,
    command: safeCommand.normalizedCommand,
    cwd: projectDir,
    pid: record.pid
  });

  let initialOutput = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    initialOutput += text;
    appendProcessOutput(record.id, text);
    appendCommandLog({
      command: safeCommand.normalizedCommand,
      cwd: projectDir,
      output: text,
      status: "stream"
    });
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    initialOutput += text;
    appendProcessOutput(record.id, text);
    appendCommandLog({
      command: safeCommand.normalizedCommand,
      cwd: projectDir,
      output: text,
      status: "stream"
    });
  });

  child.once("error", (error) => {
    appendProcessOutput(record.id, `\n[spawn error] ${error.message}`);
  });

  child.once("exit", async (code, signal) => {
    const finalOutput = `[process exit] code=${code ?? "-"} signal=${signal ?? "-"}`;
    appendProcessOutput(record.id, `\n${finalOutput}`);
    await appendCommandLog({
      command: safeCommand.normalizedCommand,
      cwd: projectDir,
      output: finalOutput,
      status: "exit",
      exitCode: code
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 3500));
  if (record.status !== "running" && record.status !== "stopping") {
    const failed = record.exitCode !== 0 || record.status === "error";
    return {
      ok: !failed,
      exitCode: record.exitCode,
      output: truncateOutput(
        [
          failed ? "Process gagal langsung setelah dijalankan." : "Process selesai langsung setelah dijalankan.",
          `command: ${safeCommand.normalizedCommand}`,
          `status: ${record.status}`,
          record.exitCode !== null ? `exit: ${record.exitCode}` : null,
          "",
          record.output || initialOutput || "(tidak ada output)"
        ].filter(Boolean).join("\n")
      ),
      command: safeCommand.normalizedCommand,
      process: record
    };
  }

  return {
    ok: true,
    output: truncateOutput(
      [
        `Process dimulai: ${safeCommand.normalizedCommand}`,
        `id: ${record.id}`,
        `pid: ${record.pid}`,
        `label: ${record.label}`,
        "",
        initialOutput || "(belum ada output awal)"
      ].join("\n")
    ),
    process: record
  };
}

export async function restartDevServer(projectDir) {
  const existing = findProcess("dev-server");
  if (existing && existing.status === "running") {
    await stopProcess("dev-server");
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return runCommand("npm run dev", projectDir, { userId: "restart" });
}

export async function readCommandLogs(maxChars = config.maxOutputChars) {
  const content = await fs.readFile(config.commandLogFile, "utf8").catch(() => "");
  if (!content) return "Belum ada log command.";
  return truncateOutput(content.slice(-Math.max(maxChars * 2, 6000)), maxChars);
}

// ── Full Shell Access ──

const shellBlockedPatterns = [];

// Files the bot itself uses — never allow access
const botProtectedPaths = [
  ".env",
  "telegram-antigravity",
  config.telegramBotToken?.slice(0, 10)
].filter(Boolean);

function assertShellSafe(command, { approved = false } = {}) {
  // Raw shell tetap lewat destructive-command guard.
  const destructiveReason = getDestructiveCommandReason(command, { approved });
  if (destructiveReason) {
    throw new Error(`Command diblokir: ${destructiveReason}`);
  }
}

const shellTimeoutMs = 300000; // 5 minutes for shell commands

// ─────────────────────────────────────────────
// Shell selection (PowerShell / cmd / Git Bash)
// ─────────────────────────────────────────────
//
// Default: PowerShell di Windows, bash di POSIX.
// User boleh override per-call (opts.shell) atau di .env (DEFAULT_SHELL).
// Git Bash optional: butuh GIT_BASH_PATH atau auto-detect lokasi default.

function locateGitBash() {
  if (config.gitBashPath && fsSync.existsSync(config.gitBashPath)) return config.gitBashPath;
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    `${process.env.LOCALAPPDATA || ""}\\Programs\\Git\\bin\\bash.exe`,
    `${process.env.ProgramW6432 || ""}\\Git\\bin\\bash.exe`
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fsSync.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

/**
 * Build spawn() args for a given shell.
 * Return { executable, args, useShellOption }.
 *
 * - PowerShell: pakai `-NoProfile -Command <cmd>`. Tidak butuh shell:true.
 * - cmd: pakai `cmd.exe /d /s /c "<cmd>"`. Tidak butuh shell:true.
 * - bash: pakai `bash -lc "<cmd>"` (Git Bash di Windows atau bash native).
 */
function buildShellSpawn(command, { shell = config.defaultShell } = {}) {
  const normalized = String(command || "").trim();
  if (!normalized) throw new Error("Command kosong.");

  // POSIX: tetap bash native
  if (process.platform !== "win32") {
    return {
      shell: "bash",
      executable: "/bin/bash",
      args: ["-lc", normalized],
      useShellOption: false
    };
  }

  // Windows
  if (shell === "powershell") {
    // Prefer PowerShell 7 (pwsh) kalau ada, fallback ke Windows PowerShell.
    const pwshPath = locateExecutable("pwsh.exe") || "powershell.exe";
    return {
      shell: "powershell",
      executable: pwshPath,
      args: ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", normalized],
      useShellOption: false
    };
  }

  if (shell === "cmd") {
    return {
      shell: "cmd",
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", normalized],
      useShellOption: false
    };
  }

  if (shell === "bash") {
    const bashPath = locateGitBash();
    if (!bashPath) {
      throw new Error("Git Bash tidak terdeteksi. Install Git for Windows atau set GIT_BASH_PATH di .env.");
    }
    return {
      shell: "bash",
      executable: bashPath,
      args: ["-lc", normalized],
      useShellOption: false
    };
  }

  // Fallback: PowerShell
  return {
    shell: "powershell",
    executable: "powershell.exe",
    args: ["-NoProfile", "-Command", normalized],
    useShellOption: false
  };
}

function locateExecutable(name) {
  // Hanya cek lokasi umum biar gak panggil where.exe tiap kali.
  const dirs = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "PowerShell", "7"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7"),
    "C:\\Program Files\\PowerShell\\7",
    "C:\\Program Files (x86)\\PowerShell\\7"
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { if (fsSync.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

/**
 * Run an arbitrary shell command with full access.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string} [opts.userId]   — untuk log
 * @param {"powershell"|"cmd"|"bash"} [opts.shell]
 */
export async function runShellCommand(command, cwd, { userId = "admin", shell, approved = false } = {}) {
  const normalizedCommand = String(command || "").trim();
  if (!normalizedCommand) {
    return { ok: false, output: "Command kosong." };
  }

  let spec;
  try {
    spec = buildShellSpawn(normalizedCommand, { shell });
  } catch (err) {
    return { ok: false, output: err.message };
  }

  try {
    assertShellSafe(normalizedCommand, { approved });
  } catch (error) {
    await logger.warn("Shell command blocked", { command: redactSecrets(normalizedCommand), reason: error.message });
    return { ok: false, output: error.message };
  }

  await logger.info("Shell command executed", {
    shell: spec.shell,
    command: redactSecrets(normalizedCommand),
    cwd,
    userId
  });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1"
        }
      });
    } catch (error) {
      const finalOutput = truncateOutput(`[spawn error] ${error.message}`);
      appendCommandLog({
        command: normalizedCommand,
        cwd,
        output: finalOutput,
        status: "shell-error"
      });
      resolve({ ok: false, output: finalOutput, command: normalizedCommand });
      return;
    }

    let output = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild(child);
      const finalOutput = truncateOutput(`${output}\n\n[timeout] Command dihentikan setelah ${shellTimeoutMs / 1000}s.`);
      appendCommandLog({
        command: normalizedCommand,
        cwd,
        output: finalOutput,
        status: "shell-timeout"
      });
      resolve({ ok: false, output: finalOutput, command: normalizedCommand });
    }, shellTimeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.once("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const finalOutput = truncateOutput(`[spawn error] ${error.message}\n${output}`);
      await appendCommandLog({
        command: normalizedCommand,
        cwd,
        output: finalOutput,
        status: "shell-error"
      });
      resolve({ ok: false, output: finalOutput, command: normalizedCommand });
    });

    child.once("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const finalOutput = truncateOutput(output || "(command selesai tanpa output)", 8000);
      await appendCommandLog({
        command: normalizedCommand,
        cwd,
        output: finalOutput,
        status: code === 0 ? "shell-success" : "shell-failed",
        exitCode: code
      });
      resolve({
        ok: code === 0,
        exitCode: code,
        output: finalOutput,
        command: normalizedCommand,
        shell: spec.shell
      });
    });
  });
}
