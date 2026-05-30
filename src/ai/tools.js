// Tool registry for the autonomous coding agent.
// Each tool is a JSON-schema-described function the AI can request.
// Agent loop: AI emits {tool: "...", args: {...}} -> we run -> feed result back -> repeat.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath, assertNotSensitivePath, getDestructiveCommandReason, redactSecrets, truncateOutput } from "../utils/security.js";
import { runCommand } from "../system/terminal.js";

const MAX_TOOL_OUTPUT = 8000;
const ignoredDirs = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ".cache", ".vercel"
]);

export const toolSpecs = [
  {
    name: "read_file",
    description: "Read the full content of a file in the active project. Returns the file content (truncated if too long).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path (e.g. src/App.jsx)" }
      },
      required: ["path"]
    }
  },
  {
    name: "list_dir",
    description: "List files and folders inside a project directory. Useful to discover the project structure.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path. Use '.' for root." }
      },
      required: ["path"]
    }
  },
  {
    name: "search",
    description: "Search for a regex pattern across project files. Returns matching file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern (case-insensitive)." },
        glob: { type: "string", description: "Optional file extension filter, e.g. 'js,jsx,ts,tsx'. Default: all text files." }
      },
      required: ["pattern"]
    }
  },
  {
    name: "run_command",
    description: "Run a safe shell command in the project root (whitelist: npm, npx, git, node, pnpm, yarn). Returns stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The full command line." }
      },
      required: ["command"]
    }
  },
  {
    name: "git_status",
    description: "Quick git status overview (porcelain) of the project. Cheaper than run_command for status checks.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "git_diff",
    description: "Show git diff. Optionally limit to a single file path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional file path." },
        staged: { type: "boolean", description: "If true, show --staged diff." }
      }
    }
  },
  {
    name: "write_file",
    description: "Write or overwrite a file with the provided content. Creates a backup if the file already exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Full file content (not a diff)." }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "apply_diff",
    description: "Apply a search-replace edit to an existing file. Use this for small targeted edits to avoid rewriting whole files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string", description: "Exact text to find (must appear once)." },
        replace: { type: "string", description: "Replacement text." }
      },
      required: ["path", "search", "replace"]
    }
  },
  {
    name: "finish",
    description: "Signal that the task is complete. Provide a summary for the user.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short summary of what was done." }
      },
      required: ["summary"]
    }
  }
];

export function toolSpecsForPrompt() {
  return toolSpecs.map((t) => {
    const props = t.parameters.properties;
    const args = Object.entries(props)
      .map(([k, v]) => `${k}: ${v.type}${t.parameters.required?.includes(k) ? "" : "?"}`)
      .join(", ");
    return `- ${t.name}(${args}) — ${t.description}`;
  }).join("\n");
}

// ─────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────

const COMMAND_WHITELIST = /^(npm|npx|pnpm|yarn|node|git)\b/;

async function toolReadFile(projectDir, args) {
  const abs = resolveProjectPath(projectDir, args.path);
  assertNotSensitivePath(abs);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${args.path}`);
  if (stat.size > 200_000) {
    return { ok: false, output: `File too large (${stat.size} bytes). Use search or read smaller files.` };
  }
  const content = await fs.readFile(abs, "utf8");
  return {
    ok: true,
    output: truncateOutput(redactSecrets(content), MAX_TOOL_OUTPUT),
    meta: { size: stat.size, truncated: content.length > MAX_TOOL_OUTPUT }
  };
}

async function toolListDir(projectDir, args) {
  const target = args.path === "." || !args.path
    ? projectDir
    : resolveProjectPath(projectDir, args.path);
  assertNotSensitivePath(target);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Not a directory: ${args.path}`);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const filtered = entries
    .filter((e) => !ignoredDirs.has(e.name))
    .filter((e) => !e.name.startsWith(".") || e.name === ".github")
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const lines = filtered.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return { ok: true, output: lines.join("\n") || "(empty)" };
}

async function toolSearch(projectDir, args) {
  const pattern = String(args.pattern || "").trim();
  if (!pattern) throw new Error("Empty search pattern.");
  const exts = String(args.glob || "js,jsx,ts,tsx,json,md,css,scss,html,vue,py,rs,go,java,kt")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch (e) {
    throw new Error(`Invalid regex: ${e.message}`);
  }
  const hits = [];
  let scanned = 0;
  const MAX_SCAN = 800;

  async function walk(dir) {
    if (scanned >= MAX_SCAN || hits.length >= 80) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (scanned >= MAX_SCAN || hits.length >= 80) return;
      if (ignoredDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (exts.length > 0 && !exts.includes(ext)) continue;
      try {
        scanned++;
        const stat = await fs.stat(full);
        if (stat.size > 250_000) continue;
        const content = await fs.readFile(full, "utf8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const rel = path.relative(projectDir, full).split(path.sep).join("/");
            hits.push(`${rel}:${i + 1}: ${truncateOutput(lines[i].trim(), 160)}`);
            if (hits.length >= 80) return;
          }
        }
      } catch {}
    }
  }

  await walk(projectDir);
  return {
    ok: true,
    output: hits.length
      ? `Found ${hits.length} matches${hits.length >= 80 ? " (truncated)" : ""}:\n${hits.join("\n")}`
      : "No matches found."
  };
}

async function toolRunCommand(projectDir, args, { userId } = {}) {
  const cmd = String(args.command || "").trim();
  if (!cmd) throw new Error("Empty command.");
  if (!COMMAND_WHITELIST.test(cmd)) {
    return { ok: false, output: `Command '${cmd.split(" ")[0]}' not in whitelist (npm/npx/pnpm/yarn/node/git).` };
  }
  const destructiveReason = getDestructiveCommandReason(cmd);
  if (destructiveReason) {
    return { ok: false, output: `Command rejected: ${destructiveReason}` };
  }
  const res = await runCommand(cmd, projectDir, { userId: `agent-tool:${userId || "anon"}` });
  return {
    ok: res.ok,
    output: truncateOutput(res.output || "", MAX_TOOL_OUTPUT),
    meta: { exitCode: res.exitCode }
  };
}

async function toolGitStatus(projectDir, _args, { userId } = {}) {
  const res = await runCommand("git status --short --branch", projectDir, { userId: `agent-git:${userId || "anon"}` });
  if (!res.ok && /not a git repo/i.test(res.output || "")) {
    return { ok: false, output: "Not a git repository." };
  }
  return {
    ok: res.ok,
    output: truncateOutput(res.output || "(clean)", 4000),
    meta: { exitCode: res.exitCode }
  };
}

async function toolGitDiff(projectDir, args, { userId } = {}) {
  const parts = ["git", "diff"];
  if (args?.staged) parts.push("--staged");
  if (args?.path) parts.push("--", String(args.path));
  const res = await runCommand(parts.join(" "), projectDir, { userId: `agent-git:${userId || "anon"}` });
  return {
    ok: res.ok,
    output: truncateOutput(res.output || "(no diff)", 6000),
    meta: { exitCode: res.exitCode }
  };
}

async function toolWriteFile(projectDir, args) {
  const abs = resolveProjectPath(projectDir, args.path);
  assertNotSensitivePath(abs);
  const { writeProjectFileWithBackup } = await import("../utils/fileManager.js");
  const result = await writeProjectFileWithBackup(projectDir, args.path, args.content);
  return {
    ok: true,
    output: `Wrote ${result.relativePath} (${args.content.length} chars)${result.backup ? ` (backup: ${result.backup.backupPath})` : ""}`,
    meta: { relativePath: result.relativePath, backup: result.backup?.backupPath || null }
  };
}

async function toolApplyDiff(projectDir, args) {
  const abs = resolveProjectPath(projectDir, args.path);
  assertNotSensitivePath(abs);
  const original = await fs.readFile(abs, "utf8");
  const search = String(args.search || "");
  const replace = String(args.replace || "");
  if (!search) throw new Error("Empty search string.");
  const occurrences = original.split(search).length - 1;
  if (occurrences === 0) {
    // Provide hint: find the closest line by token overlap
    const searchLines = search.split("\n").map((l) => l.trim()).filter(Boolean);
    const fileLines = original.split("\n");
    let bestLine = -1;
    let bestScore = 0;
    for (let i = 0; i < fileLines.length; i++) {
      const trimmed = fileLines[i].trim();
      if (!trimmed) continue;
      let score = 0;
      for (const sl of searchLines) {
        if (trimmed.includes(sl) || sl.includes(trimmed)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLine = i;
      }
    }
    let hint = "";
    if (bestLine >= 0 && bestScore > 0) {
      const start = Math.max(0, bestLine - 2);
      const end = Math.min(fileLines.length, bestLine + 3);
      const snippet = fileLines.slice(start, end).map((l, idx) => `${start + idx + 1}: ${l}`).join("\n");
      hint = `\n\nClosest match around line ${bestLine + 1}:\n${snippet}`;
    }
    return {
      ok: false,
      output: `Search string not found in ${args.path}.${hint}\n\nTip: use read_file to see exact content, or use write_file to overwrite the whole file.`
    };
  }
  if (occurrences > 1) {
    return { ok: false, output: `Search string is ambiguous (matches ${occurrences} times in ${args.path}). Provide more surrounding context to make it unique.` };
  }
  const next = original.replace(search, replace);
  const { writeProjectFileWithBackup } = await import("../utils/fileManager.js");
  const result = await writeProjectFileWithBackup(projectDir, args.path, next);
  return {
    ok: true,
    output: `Patched ${result.relativePath} (1 hunk, ${next.length - original.length >= 0 ? "+" : ""}${next.length - original.length} chars)`,
    meta: { relativePath: result.relativePath, backup: result.backup?.backupPath || null }
  };
}

const toolHandlers = {
  read_file: toolReadFile,
  list_dir: toolListDir,
  search: toolSearch,
  run_command: toolRunCommand,
  git_status: toolGitStatus,
  git_diff: toolGitDiff,
  write_file: toolWriteFile,
  apply_diff: toolApplyDiff
};

export async function executeTool({ name, args, projectDir, userId }) {
  if (name === "finish") {
    return { ok: true, output: args?.summary || "done", final: true };
  }
  const handler = toolHandlers[name];
  if (!handler) {
    return { ok: false, output: `Unknown tool: ${name}` };
  }
  try {
    return await handler(projectDir, args || {}, { userId });
  } catch (err) {
    return { ok: false, output: `Tool error: ${err.message}` };
  }
}
