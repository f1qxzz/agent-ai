// Generic CLI runner shared by AI CLI providers (contoh: Kiro CLI).
// Avoids `shell: true` (which triggers Node DEP0190 + Windows .cmd issues) by
// routing .cmd/.bat/.ps1 invocations through cmd.exe /d /s /c.

import { spawn } from "child_process";

function parseExtraArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter(Boolean);
}

function resolveSpawn(command, args) {
  if (process.platform !== "win32") {
    return { file: command, spawnArgs: args, options: {} };
  }
  const lower = command.toLowerCase();
  const isPath = command.includes("\\") || command.includes("/");
  const looksLikeScript = /\.(cmd|bat|ps1)$/.test(lower);
  if (looksLikeScript || (!isPath && !lower.endsWith(".exe"))) {
    const quoted = [command, ...args].map((part) => {
      const s = String(part);
      if (s === "") return '""';
      if (/[\s"&|<>^]/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"';
      return s;
    });
    return {
      file: "cmd.exe",
      spawnArgs: ["/d", "/s", "/c", quoted.join(" ")],
      options: { windowsVerbatimArguments: true }
    };
  }
  return { file: command, spawnArgs: args, options: {} };
}

/**
 * Cek ketersediaan binary CLI lewat --version.
 * Return { ok, version, error } — never throws.
 */
export async function checkCliBinary(command, { timeoutMs = 4000, versionFlag = "--version" } = {}) {
  return new Promise((resolve) => {
    const { file, spawnArgs, options } = resolveSpawn(command, [versionFlag]);
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child;
    try {
      child = spawn(file, spawnArgs, { stdio: ["ignore", "pipe", "pipe"], ...options });
    } catch (err) {
      resolve({ ok: false, version: "", error: err?.message || String(err) });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ ok: false, version: "", error: `${command} tidak merespon (timeout ${timeoutMs}ms)` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      const msg = err?.code === "ENOENT"
        ? `Binary "${command}" tidak ditemukan.`
        : (err?.message || String(err));
      finish({ ok: false, version: "", error: msg });
    });

    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, version: stdout.trim() || "ok", error: "" });
      else finish({ ok: false, version: "", error: stderr.trim() || `exit ${code}` });
    });
  });
}

/**
 * Run a CLI binary with a prompt fed via stdin. Returns the stdout (trimmed).
 *
 * @param {object} opts
 * @param {string} opts.command - Binary name (e.g. "kiro-cli")
 * @param {string[]} opts.args - CLI args (e.g. ["-p", "--model", "opus"])
 * @param {string} opts.prompt - Prompt to write to stdin.
 * @param {number} opts.timeoutMs
 * @param {string} opts.cwd
 * @param {string} opts.label - Human-readable label for error messages.
 */
export async function runCliBinary({ command, args, prompt, timeoutMs, cwd, label = "CLI" }) {
  const { file, spawnArgs, options } = resolveSpawn(command, args);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        ...options
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error(`${label} timeout setelah ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err?.code === "ENOENT") {
        reject(new Error(`${label} "${command}" tidak ditemukan. Cek instalasi binary atau PATH.`));
      } else {
        reject(err);
      }
    });

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        const detail = (stderr || stdout || `exit ${code}`).trim();
        reject(new Error(`${label} gagal (exit ${code}): ${detail}`));
        return;
      }
      resolve(stdout.replace(/\r/g, "").trim());
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export { parseExtraArgs };
