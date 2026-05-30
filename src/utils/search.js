import fs from "fs/promises";
import path from "path";
import { isSensitivePath, resolveProjectPath, truncateOutput } from "./security.js";

const ignoredDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);
const textExtensions = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".py",
  ".yml",
  ".yaml",
  ".env.example"
]);

function toRelative(projectDir, absolutePath) {
  return path.relative(projectDir, absolutePath).split(path.sep).join("/");
}

function isTextCandidate(absolutePath) {
  if (isSensitivePath(absolutePath)) return false;
  return textExtensions.has(path.extname(absolutePath).toLowerCase());
}

async function walkFiles(projectDir, { maxFiles = 800 } = {}) {
  const files = [];

  async function walk(dir) {
    if (files.length >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) await walk(absolute);
        continue;
      }
      if (entry.isFile() && isTextCandidate(absolute)) files.push(absolute);
    }
  }

  await walk(projectDir);
  return files;
}

export async function searchProject(projectDir, query, { maxResults = 20 } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) throw new Error("Query search wajib diisi.");

  const files = await walkFiles(projectDir);
  const results = [];

  for (const absolute of files) {
    const raw = await fs.readFile(absolute, "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLowerCase().includes(needle)) {
        results.push({
          filePath: toRelative(projectDir, absolute),
          line: index + 1,
          text: truncateOutput(lines[index].trim(), 240)
        });
        if (results.length >= maxResults) return results;
      }
    }
  }

  return results;
}

export function formatSearchResults(results) {
  if (!results.length) return "Tidak ada hasil.";
  return results.map((item) => `${item.filePath}:${item.line} ${item.text}`).join("\n");
}

export function extractFileRefs(text) {
  const refs = new Set();
  const value = String(text || "");
  const patterns = [
    /((?:src|app|pages|components|lib|utils|styles|public|server|client|api)[\\/][^\s'"`()]+?\.(?:jsx?|tsx?|mjs|cjs|json|css|scss|py|md))(?::\d+)?(?::\d+)?/gi,
    /([A-Za-z0-9_.-]+\.(?:jsx?|tsx?|mjs|cjs|json|css|scss|py|md))(?::\d+)?(?::\d+)?/g
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      refs.add(match[1].replace(/\\/g, "/").replace(/[),.;]+$/g, ""));
    }
  }

  return [...refs];
}

export async function inferFileFromText(projectDir, text) {
  const refs = extractFileRefs(text);
  for (const ref of refs) {
    try {
      const absolute = resolveProjectPath(projectDir, ref);
      const stat = await fs.stat(absolute).catch(() => null);
      if (stat?.isFile()) return ref;
    } catch {
      // ignore invalid refs
    }
  }
  return null;
}
