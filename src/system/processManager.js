import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { config } from "../core/config.js";
import {
  assertInsideBase,
  isBlockedWorkspaceChildName,
  isPathInside,
  resolveWorkspacePath,
  resolveWorkspaceProject,
  truncateOutput
} from "../utils/security.js";
import { logger } from "../core/logger.js";
import { clearSessionData, setLast, getLast } from "../core/memory.js";
import { EventEmitter } from "events";

export const processEvents = new EventEmitter();

let activeProjectDir = null;
let activeWorkspaceDir = null;
let nextProcessId = 1;
const processes = new Map();

async function ensureDirectoryExists(dirPath) {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (stat?.isDirectory()) return;
  if (stat) throw new Error(`Path bukan folder: ${dirPath}`);
  await fs.mkdir(dirPath, { recursive: true });
}

export function getActiveProjectDir() {
  if (!activeProjectDir) {
    throw new Error("Belum ada project aktif. Jalankan /projects lalu /switch project_name.");
  }
  return activeProjectDir;
}

export function getActiveProjectPath() {
  return activeProjectDir;
}

export function getActiveProjectName() {
  return activeProjectDir ? path.basename(activeProjectDir) : "(belum ada)";
}

export function getWorkspaceDir() {
  return activeWorkspaceDir;
}

export async function ensureActiveProject() {
  const savedWorkspace = await getLast("activeWorkspaceDir");
  const savedProject = await getLast("activeProjectDir");
  activeWorkspaceDir = path.resolve(savedWorkspace || activeWorkspaceDir || config.workspaceDir);
  if (typeof savedProject === "string") {
    activeProjectDir = savedProject.trim() ? path.resolve(savedProject) : null;
  } else {
    activeProjectDir = activeProjectDir ? path.resolve(activeProjectDir) : path.resolve(config.projectDir);
  }

  if (activeProjectDir && !isPathInside(activeWorkspaceDir, activeProjectDir)) {
    activeProjectDir = null;
  }

  if (!activeProjectDir) {
    await ensureDirectoryExists(activeWorkspaceDir);
    await setLast("activeWorkspaceDir", activeWorkspaceDir);
    await setLast("activeProjectDir", "");
    return null;
  }
  await ensureDirectoryExists(activeProjectDir);
  await setLast("activeWorkspaceDir", activeWorkspaceDir);
  await setLast("activeProjectDir", activeProjectDir);
  if (!(await getLast("activeProjectOpenedAt"))) {
    await setLast("activeProjectOpenedAt", new Date().toISOString());
  }
  return activeProjectDir;
}

export async function listProjects() {
  if (!activeWorkspaceDir) await ensureActiveProject();
  await ensureDirectoryExists(activeWorkspaceDir);
  const entries = await fs.readdir(activeWorkspaceDir, { withFileTypes: true });
  const excludeList = ["system volume information", "steamlibrary", "program files", "program files (x86)", "windows", "recovery", "perflogs", "documents and settings", "msocache"];
  
  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      if (entry.name.startsWith(".") || entry.name.startsWith("$")) return false;
      if (excludeList.includes(entry.name.toLowerCase())) return false;
      return !isBlockedWorkspaceChildName(entry.name);
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function switchProject(projectName) {
  const targetDir = resolveWorkspaceProject(activeWorkspaceDir, projectName);
  const stat = await fs.stat(targetDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Project "${projectName}" tidak ditemukan di workspace.`);
  }
  activeProjectDir = targetDir;
  await setLast("activeProjectDir", targetDir);
  await setLast("activeProjectOpenedAt", new Date().toISOString());
  await clearSessionData();
  await logger.info("Project aktif diganti", { activeProjectDir, activeWorkspaceDir });
  return activeProjectDir;
}

export async function switchWorkspace(workspacePath) {
  const targetDir = resolveWorkspacePath(workspacePath);
  const stat = await fs.stat(targetDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Workspace tidak ditemukan: ${targetDir}`);
  }

  activeWorkspaceDir = targetDir;
  await setLast("activeWorkspaceDir", targetDir);
  const projects = await listProjects();

  activeProjectDir = null;
  await setLast("activeProjectDir", "");
  await clearSessionData();
  await logger.info("Workspace aktif diganti", { activeWorkspaceDir, activeProjectDir });
  return {
    workspaceDir: activeWorkspaceDir,
    activeProjectDir,
    projects
  };
}

export async function listAvailableDrives() {
  if (process.platform !== "win32") return ["/"];

  const drives = [];
  for (const letter of ["C", "D"]) {
    const drivePath = `${letter}:\\`;
    const exists = await fs
      .access(drivePath)
      .then(() => true)
      .catch(() => false);
    if (exists) drives.push(drivePath);
  }
  return drives;
}

export function registerProcess({ command, cwd, label, child, longRunning = true }) {
  assertInsideBase(path.resolve(cwd), path.resolve(cwd));
  const id = String(nextProcessId++);
  const now = new Date();
  const record = {
    id,
    label: label || `process-${id}`,
    command,
    cwd,
    pid: child.pid,
    status: "running",
    startedAt: now.toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    longRunning,
    output: ""
  };

  processes.set(id, record);

  child.once("exit", (code, signal) => {
    record.status = record.status === "stopping" ? "stopped" : "exited";
    record.endedAt = new Date().toISOString();
    record.exitCode = code;
    record.signal = signal;

    if (longRunning && code !== 0 && code !== null && record.status !== "stopped") {
      processEvents.emit("crash", record);
    }
  });

  child.once("error", (error) => {
    record.status = "error";
    record.endedAt = new Date().toISOString();
    record.output = truncateOutput(`${record.output}\n[process error] ${error.message}`, 12000);
  });

  return record;
}

export function appendProcessOutput(id, chunk) {
  const record = processes.get(String(id));
  if (!record) return;
  record.output = truncateOutput(`${record.output}${chunk}`, 12000);
}

export function listRunningProcesses() {
  return [...processes.values()]
    .filter((record) => record.status === "running" || record.status === "stopping")
    .map((record) => ({ ...record, output: truncateOutput(record.output, 1200) }));
}

export function listAllProcesses() {
  return [...processes.values()].map((record) => ({ ...record, output: truncateOutput(record.output, 1200) }));
}

export function findProcess(idOrLabel) {
  const needle = String(idOrLabel || "").trim();
  if (!needle) return null;
  if (processes.has(needle)) return processes.get(needle);
  return [...processes.values()].find((record) => record.label === needle) || null;
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.once("close", () => resolve(true));
      killer.once("error", () => resolve(false));
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
      resolve(true);
    } catch {
      try {
        process.kill(pid, "SIGTERM");
        resolve(true);
      } catch {
        resolve(false);
      }
    }
  });
}

export async function stopProcess(idOrLabel = "dev-server") {
  const record = findProcess(idOrLabel);
  if (!record) return { stopped: false, message: "Process tidak ditemukan." };
  if (record.status !== "running") return { stopped: false, message: `Process sudah ${record.status}.` };

  record.status = "stopping";
  const killed = await killProcessTree(record.pid);
  if (!killed) {
    record.status = "error";
    return { stopped: false, message: "Gagal menghentikan process." };
  }

  await logger.info("Process dihentikan", { id: record.id, label: record.label, pid: record.pid });
  return { stopped: true, message: `Process ${record.label} dihentikan.`, record };
}

export async function stopAllProcesses() {
  const running = listRunningProcesses();
  const results = [];
  for (const record of running) {
    results.push(await stopProcess(record.id));
  }
  return results;
}

export function getProcessStatusText() {
  const records = listAllProcesses();
  if (records.length === 0) return "Tidak ada process yang pernah dijalankan.";

  return records
    .slice(-10)
    .map((record) => {
      const cwdLabel = path.basename(record.cwd);
      return [
        `#${record.id} ${record.label}`,
        `command: ${record.command}`,
        `cwd: ${cwdLabel}`,
        `pid: ${record.pid || "-"}`,
        `status: ${record.status}`,
        `started: ${record.startedAt}`,
        record.endedAt ? `ended: ${record.endedAt}` : null,
        record.exitCode !== null ? `exit: ${record.exitCode}` : null
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
