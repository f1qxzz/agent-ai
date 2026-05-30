import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { logger } from "../core/logger.js";

const execFileAsync = promisify(execFile);

async function commandExists(command) {
  try {
    const lookup = process.platform === "win32" ? ["where", [command]] : ["which", [command]];
    const { stdout } = await execFileAsync(lookup[0], lookup[1], { windowsHide: true, timeout: 5000 });
    return stdout.trim().split(/\r?\n/).filter(Boolean).sort(sortCliPath);
  } catch {
    return [];
  }
}

function sortCliPath(a, b) {
  const rank = new Map([
    [".exe", 0],
    [".cmd", 1],
    [".bat", 2],
    [".ps1", 3]
  ]);
  return (rank.get(path.extname(a).toLowerCase()) ?? 9) - (rank.get(path.extname(b).toLowerCase()) ?? 9);
}

async function detectProcessInfo() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Get-Process | Where-Object { $_.ProcessName -match 'Antigravity|antigravity' } | Select-Object ProcessName,Path | ConvertTo-Json -Compress"
        ],
        { windowsHide: true, timeout: 6000 }
      );
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
        name: item.ProcessName,
        path: item.Path
      }));
    }

    const { stdout } = await execFileAsync("ps", ["-axo", "comm"], { timeout: 6000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /antigravity/i.test(line))
      .map((name) => ({ name, path: null }));
  } catch (error) {
    await logger.warn("Gagal mendeteksi process Antigravity", { error: error.message });
    return [];
  }
}

function getAntigravityExecutableCandidates(processInfo = []) {
  const candidates = [
    ...processInfo.map((item) => item.path).filter(Boolean),
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity", "Antigravity.exe")
      : null,
    process.platform === "win32" && process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Antigravity", "Antigravity.exe")
      : null,
    process.platform === "win32" && process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Antigravity", "Antigravity.exe")
      : null
  ].filter(Boolean);

  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate));
}

function openExecutableDetached(executablePath, projectDir) {
  const child = spawn(executablePath, [projectDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
}

async function runAntigravityCli(cliPath, projectDir) {
  const extension = path.extname(cliPath).toLowerCase();

  if (process.platform === "win32" && [".cmd", ".bat"].includes(extension)) {
    await execFileAsync(
      "cmd.exe",
      ["/d", "/c", "call", cliPath, projectDir],
      { windowsHide: true, timeout: 10000 }
    );
    return;
  }

  if (process.platform === "win32" && extension === ".ps1") {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cliPath, projectDir],
      { windowsHide: true, timeout: 10000 }
    );
    return;
  }

  await execFileAsync(cliPath, [projectDir], { windowsHide: true, timeout: 10000 });
}

export async function detectAntigravity() {
  const [processInfo, cliPaths] = await Promise.all([detectProcessInfo(), commandExists("antigravity")]);
  const executablePaths = getAntigravityExecutableCandidates(processInfo);
  return {
    active: processInfo.length > 0,
    processes: [...new Set(processInfo.map((item) => item.name).filter(Boolean))],
    cliAvailable: cliPaths.length > 0,
    cliPaths,
    executableAvailable: executablePaths.length > 0,
    executablePaths
  };
}

export async function openProjectInAntigravity(projectDir) {
  const status = await detectAntigravity();
  if (status.cliPaths.length > 0) {
    try {
      await runAntigravityCli(status.cliPaths[0], projectDir);
      return { opened: true, message: `Project dibuka di Antigravity: ${projectDir}` };
    } catch (error) {
      return { opened: false, message: `Gagal membuka Antigravity CLI: ${error.message}` };
    }
  }

  if (status.executablePaths.length > 0) {
    try {
      openExecutableDetached(status.executablePaths[0], projectDir);
      return { opened: true, message: `Project dibuka lewat Antigravity.exe: ${projectDir}` };
    } catch (error) {
      return { opened: false, message: `Gagal membuka Antigravity.exe: ${error.message}` };
    }
  }

  if (!status.active) {
    return {
      opened: false,
      message: "Antigravity tidak terdeteksi. Jalankan Antigravity atau buka project secara manual."
    };
  }

  return {
    opened: false,
    message: "Antigravity aktif, tetapi CLI/executable tidak ditemukan. Project aktif bot tetap sudah diganti."
  };
}

export function describeAntigravityStatus(status) {
  return [
    `Antigravity aktif: ${status.active ? "ya" : "tidak terdeteksi"}`,
    `CLI tersedia: ${status.cliAvailable ? "ya" : "tidak"}`,
    `Executable tersedia: ${status.executableAvailable ? "ya" : "tidak"}`,
    status.processes.length ? `process: ${status.processes.join(", ")}` : null,
    status.cliPaths.length ? `cli: ${status.cliPaths.join(", ")}` : null,
    status.executablePaths?.length ? `exe: ${status.executablePaths.join(", ")}` : null
  ]
    .filter(Boolean)
    .join("\n");
}
