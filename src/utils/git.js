// ─────────────────────────────────────────────
// Git helpers — dipakai connector & natural-language flow
// untuk verify project punya repo + remote sebelum push.
// ─────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function runGitCapture(cwd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: "", stderr: err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, code: -1, stdout, stderr: stderr || "git timeout" });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function isGitRepo(projectDir) {
  if (!projectDir) return false;
  try {
    const stat = await fs.stat(path.join(projectDir, ".git")).catch(() => null);
    if (stat) return true;
  } catch {}
  // Fallback: project bisa berada di dalam worktree / submodule
  const res = await runGitCapture(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && /true/i.test(res.stdout);
}

export async function getCurrentBranch(projectDir) {
  if (!projectDir) return null;
  const res = await runGitCapture(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) return null;
  const branch = res.stdout.trim();
  if (!branch || branch === "HEAD") return null;
  return branch;
}

/**
 * Return remote URL for `origin` (atau remote pertama kalau origin gak ada).
 * Format URL bisa SSH (git@github.com:owner/repo.git) atau HTTPS.
 */
export async function getRemoteOrigin(projectDir) {
  if (!projectDir) return null;
  const res = await runGitCapture(projectDir, ["remote", "get-url", "origin"]);
  if (res.ok && res.stdout.trim()) return res.stdout.trim();

  // Fallback: pick first remote
  const list = await runGitCapture(projectDir, ["remote", "-v"]);
  if (!list.ok || !list.stdout.trim()) return null;
  const firstLine = list.stdout.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^\S+\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Parse owner/repo dari remote URL GitHub. Return null kalau bukan GitHub.
 */
export function parseGithubRemote(url) {
  if (!url) return null;
  const cleaned = String(url).trim().replace(/\.git$/i, "");
  // SSH: git@github.com:owner/repo
  let match = cleaned.match(/^git@([^:]+):([^/]+)\/(.+)$/i);
  if (match && /github\.com$/i.test(match[1])) {
    return { host: match[1], owner: match[2], repo: match[3] };
  }
  // HTTPS: https://github.com/owner/repo
  match = cleaned.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (match && /github\.com$/i.test(match[1])) {
    return { host: match[1], owner: match[2], repo: match[3] };
  }
  return null;
}

/**
 * Cek apakah project siap untuk git operation.
 * Return { ok, reason, branch, remote }.
 */
export async function ensureGitRepo(projectDir, { needRemote = false } = {}) {
  if (!projectDir) {
    return { ok: false, reason: "Project belum dipilih. Jalankan /projects atau /switch dulu." };
  }
  if (!(await isGitRepo(projectDir))) {
    return {
      ok: false,
      reason: [
        "Folder aktif belum Git repo.",
        `Path: ${projectDir}`,
        "",
        "Jalankan `git init` atau pilih project yang sudah punya repo."
      ].join("\n")
    };
  }
  const branch = await getCurrentBranch(projectDir);
  const remote = await getRemoteOrigin(projectDir);
  if (needRemote && !remote) {
    return {
      ok: false,
      reason: [
        "Project belum punya remote `origin`.",
        "Setup dulu:",
        "`git remote add origin git@github.com:OWNER/REPO.git`",
        "atau",
        "`git remote add origin https://github.com/OWNER/REPO.git`"
      ].join("\n"),
      branch
    };
  }
  return { ok: true, branch, remote, github: parseGithubRemote(remote) };
}

export async function getGitStatusShort(projectDir) {
  const res = await runGitCapture(projectDir, ["status", "--short", "--branch"]);
  return res;
}
