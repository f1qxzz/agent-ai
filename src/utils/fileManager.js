import fs from "fs/promises";
import path from "path";
import { config } from "../core/config.js";
import {
  assertNoSecretsForAi,
  assertNotSensitivePath,
  isSensitivePath,
  redactSecrets,
  resolveProjectPath,
  truncateOutput
} from "./security.js";

const ignoredTreeDirs = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache"
]);

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toRelative(projectDir, absolutePath) {
  return path.relative(projectDir, absolutePath).split(path.sep).join("/");
}

export async function pathExists(absolutePath) {
  return fs
    .access(absolutePath)
    .then(() => true)
    .catch(() => false);
}

export async function readProjectFile(projectDir, userPath, { forAi = false, maxChars = 120000 } = {}) {
  const absolutePath = resolveProjectPath(projectDir, userPath);
  assertNotSensitivePath(absolutePath);

  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error("Path bukan file.");
  if (stat.size > maxChars) {
    throw new Error(`File terlalu besar (${stat.size} bytes). Batas baca ${maxChars} bytes.`);
  }

  const raw = await fs.readFile(absolutePath, "utf8");
  if (forAi) {
    assertNoSecretsForAi(raw);
    return {
      absolutePath,
      relativePath: toRelative(projectDir, absolutePath),
      content: raw,
      size: stat.size
    };
  }

  return {
    absolutePath,
    relativePath: toRelative(projectDir, absolutePath),
    content: redactSecrets(raw),
    size: stat.size
  };
}

export async function backupProjectFile(projectDir, userPath) {
  const absolutePath = resolveProjectPath(projectDir, userPath);
  assertNotSensitivePath(absolutePath);

  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error("Path bukan file.");

  const relativePath = path.relative(projectDir, absolutePath);
  const backupPath = path.join(config.backupsDir, path.basename(projectDir), timestamp(), relativePath);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(absolutePath, backupPath);

  return {
    sourcePath: absolutePath,
    backupPath,
    relativePath: toRelative(projectDir, absolutePath)
  };
}

export async function getProjectFileInfo(projectDir, userPath) {
  const absolutePath = resolveProjectPath(projectDir, userPath);
  assertNotSensitivePath(absolutePath);

  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error("Delete hanya diizinkan untuk file, bukan folder.");

  return {
    absolutePath,
    relativePath: toRelative(projectDir, absolutePath),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

export async function deleteProjectFileWithBackup(projectDir, userPath) {
  const info = await getProjectFileInfo(projectDir, userPath);
  const backup = await backupProjectFile(projectDir, info.relativePath);
  await fs.unlink(info.absolutePath);

  return {
    ...info,
    backup
  };
}

export async function restoreProjectFileFromBackup(projectDir, userPath, backupPath) {
  const absolutePath = resolveProjectPath(projectDir, userPath);
  assertNotSensitivePath(absolutePath);

  const backupStat = await fs.stat(backupPath).catch(() => null);
  if (!backupStat?.isFile()) throw new Error("Backup file tidak ditemukan.");

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.copyFile(backupPath, absolutePath);

  return {
    absolutePath,
    relativePath: toRelative(projectDir, absolutePath),
    restoredFrom: backupPath
  };
}

export async function writeProjectFileWithBackup(projectDir, userPath, content) {
  const absolutePath = resolveProjectPath(projectDir, userPath);
  assertNotSensitivePath(absolutePath);
  assertNoSecretsForAi(content);

  const exists = await pathExists(absolutePath);
  let backup = null;
  if (exists) {
    backup = await backupProjectFile(projectDir, userPath);
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  return {
    absolutePath,
    relativePath: toRelative(projectDir, absolutePath),
    backup
  };
}

export async function createProjectFile(projectDir, userPath, content) {
  const absolutePath = resolveProjectPath(projectDir, userPath);
  assertNotSensitivePath(absolutePath);
  assertNoSecretsForAi(content);

  if (await pathExists(absolutePath)) {
    throw new Error("File sudah ada. Gunakan /edit jika ingin mengubah file existing.");
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  return {
    absolutePath,
    relativePath: toRelative(projectDir, absolutePath)
  };
}

export async function listProjectTree(projectDir, { maxDepth = 4, maxEntries = 350 } = {}) {
  const lines = [path.basename(projectDir) || projectDir];
  let count = 0;
  let truncated = false;

  async function walk(dir, depth, prefix) {
    if (depth > maxDepth || truncated) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const visible = entries
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".github")
      .filter((entry) => !(entry.isDirectory() && ignoredTreeDirs.has(entry.name)))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (let index = 0; index < visible.length; index += 1) {
      if (count >= maxEntries) {
        truncated = true;
        lines.push(`${prefix}... tree dipotong setelah ${maxEntries} item`);
        return;
      }

      const entry = visible[index];
      const isLast = index === visible.length - 1;
      const connector = isLast ? "`-- " : "|-- ";
      const nextPrefix = `${prefix}${isLast ? "    " : "|   "}`;
      const absolute = path.join(dir, entry.name);
      if (assertTreeEntrySafe(absolute)) {
        lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        count += 1;
        if (entry.isDirectory()) await walk(absolute, depth + 1, nextPrefix);
      }
    }
  }

  await walk(projectDir, 1, "");
  return lines.join("\n");
}

function assertTreeEntrySafe(absolutePath) {
  return !absolutePath.split(path.sep).some((part) => ignoredTreeDirs.has(part)) && !isSensitivePath(absolutePath);
}

export async function getProjectContext(projectDir) {
  const pieces = [];
  pieces.push(`Project aktif: ${projectDir}`);
  pieces.push("Struktur project:");
  pieces.push(await listProjectTree(projectDir, { maxDepth: 3, maxEntries: 160 }));

  for (const fileName of ["package.json", "README.md", "vite.config.js", "next.config.js", "src/App.jsx", "src/App.js"]) {
    const absolute = path.join(projectDir, fileName);
    if (await pathExists(absolute)) {
      try {
        const file = await readProjectFile(projectDir, fileName, { forAi: true, maxChars: 4000 });
        pieces.push(`\n--- ${file.relativePath} ---\n${file.content}`);
      } catch {
        pieces.push(`\n--- ${fileName} ---\n[tidak dibaca karena terlalu besar]`);
      }
    }
  }

  return truncateOutput(pieces.join("\n\n"), 12000);
}

export function createPreview(content, maxChars = 2200) {
  return truncateOutput(redactSecrets(content), maxChars);
}
