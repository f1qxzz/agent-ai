import fs from "fs/promises";
import path from "path";
import { config } from "./config.js";
import { redactSecrets, truncateOutput } from "../utils/security.js";

const memoryFile = path.join(config.dataDir, "memory.json");
const maxConversationItems = 40;
const maxTaskItems = 60;
const pendingTtlMs = 30 * 60 * 1000;

function emptySessionState() {
  return {
    conversations: [],
    tasks: [],
    last: {},
    pending: {
      edits: {},
      deletes: {}
    },
    backups: []
  };
}

function emptyMemory() {
  return {
    version: 3,
    preferences: [],
    environment: {},
    projectFacts: {},
    corrections: [],
    workflows: [],
    sessionState: emptySessionState()
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeKey(value) {
  return String(value || "").trim();
}

function normalizeProjectKey(projectDir) {
  return path.resolve(String(projectDir || "")).replace(/\\/g, "/");
}

function sanitizeText(value, maxChars = 1000) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const redacted = redactSecrets(raw);
  if (/\[REDACTED/i.test(redacted)) {
    throw new Error("Input memory mengandung secret/token dan tidak disimpan.");
  }
  return truncateOutput(redacted.replace(/\s+/g, " "), maxChars).trim();
}

function sanitizeLoose(value, maxChars = 6000) {
  if (typeof value === "string") return truncateOutput(redactSecrets(value), maxChars);
  if (Array.isArray(value)) return value.map((item) => sanitizeLoose(item, Math.ceil(maxChars / 2))).slice(0, 100);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = sanitizeLoose(item, Math.ceil(maxChars / 2));
    }
    return out;
  }
  return value;
}

export function sanitizeMemoryInput(value, maxChars = 1000) {
  return sanitizeText(value, maxChars);
}

function dedupeAppend(list, item, limit) {
  const normalized = String(item || "").trim();
  if (!normalized) return list || [];
  return [...(list || []).filter((entry) => entry !== normalized), normalized].slice(-limit);
}

function ensureStringArray(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    try {
      const text = sanitizeText(typeof item === "string" ? item : JSON.stringify(item), 1200);
      if (text) result.push(text);
    } catch {}
  }
  return result;
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ensureMemoryShape(input) {
  const base = emptyMemory();
  const memory = ensureObject(input);
  const legacySession = {
    conversations: Array.isArray(memory.conversations) ? memory.conversations : [],
    tasks: Array.isArray(memory.tasks) ? memory.tasks : [],
    last: ensureObject(memory.last),
    pending: ensureObject(memory.pending),
    backups: Array.isArray(memory.backups) ? memory.backups : []
  };
  const session = {
    ...emptySessionState(),
    ...ensureObject(memory.sessionState)
  };

  session.conversations = Array.isArray(session.conversations) && session.conversations.length
    ? session.conversations
    : legacySession.conversations;
  session.tasks = Array.isArray(session.tasks) && session.tasks.length
    ? session.tasks
    : legacySession.tasks;
  session.last = Object.keys(ensureObject(session.last)).length ? session.last : legacySession.last;
  session.pending = {
    edits: ensureObject(session.pending?.edits || legacySession.pending?.edits),
    deletes: ensureObject(session.pending?.deletes || legacySession.pending?.deletes)
  };
  session.backups = Array.isArray(session.backups) && session.backups.length
    ? session.backups
    : legacySession.backups;

  const projectFacts = ensureObject(memory.projectFacts);
  const legacyProjects = ensureObject(memory.projects);
  for (const [projectDir, profile] of Object.entries(legacyProjects)) {
    const key = normalizeProjectKey(projectDir);
    if (!projectFacts[key]) projectFacts[key] = [];
    const facts = [];
    for (const [k, v] of Object.entries(ensureObject(profile))) {
      if (k === "updatedAt") continue;
      facts.push(`${k}: ${String(v)}`);
    }
    projectFacts[key] = [...new Set([...(Array.isArray(projectFacts[key]) ? projectFacts[key] : []), ...facts])];
  }

  const shaped = {
    ...base,
    version: 3,
    preferences: ensureStringArray(memory.preferences),
    environment: sanitizeLoose(ensureObject(memory.environment), 2000),
    projectFacts: sanitizeLoose(projectFacts, 4000),
    corrections: ensureStringArray(memory.corrections),
    workflows: Array.isArray(memory.workflows) ? sanitizeLoose(memory.workflows, 3000) : [],
    sessionState: sanitizeLoose(session, 6000)
  };

  return compactMemoryObject(shaped);
}

function sessionState(memory) {
  memory.sessionState ||= emptySessionState();
  memory.sessionState.pending ||= { edits: {}, deletes: {} };
  memory.sessionState.pending.edits ||= {};
  memory.sessionState.pending.deletes ||= {};
  memory.sessionState.conversations ||= [];
  memory.sessionState.tasks ||= [];
  memory.sessionState.last ||= {};
  memory.sessionState.backups ||= [];
  return memory.sessionState;
}

function compactMemoryObject(memory) {
  const state = sessionState(memory);
  memory.preferences = ensureStringArray(memory.preferences).slice(-50);
  memory.corrections = ensureStringArray(memory.corrections).slice(-50);
  memory.environment = sanitizeLoose(ensureObject(memory.environment), 3000);
  memory.projectFacts = sanitizeLoose(ensureObject(memory.projectFacts), 8000);
  memory.workflows = Array.isArray(memory.workflows) ? memory.workflows.slice(-30) : [];

  state.conversations = (Array.isArray(state.conversations) ? state.conversations : [])
    .map((item) => ({
      ts: item.ts || nowIso(),
      userId: String(item.userId || ""),
      role: item.role === "assistant" ? "assistant" : "user",
      projectDir: item.projectDir || "",
      text: truncateOutput(redactSecrets(String(item.text || "")), 2000)
    }))
    .filter((item) => item.text && !/\[REDACTED/i.test(item.text))
    .slice(-maxConversationItems);

  state.tasks = (Array.isArray(state.tasks) ? state.tasks : [])
    .map((task) => sanitizeLoose({
      ts: task.ts || nowIso(),
      type: task.type || "task",
      projectDir: task.projectDir || "",
      filePath: task.filePath || "",
      command: task.command || "",
      summary: task.summary ? truncateOutput(String(task.summary), 300) : "",
      status: task.status || ""
    }, 1200))
    .slice(-maxTaskItems);

  state.backups = (Array.isArray(state.backups) ? state.backups : []).slice(-100);
  state.last = sanitizeLoose(ensureObject(state.last), 6000);
  state.pending = {
    edits: ensureObject(state.pending?.edits),
    deletes: ensureObject(state.pending?.deletes)
  };

  return memory;
}

async function readMemory() {
  try {
    const raw = await fs.readFile(memoryFile, "utf8");
    return ensureMemoryShape(JSON.parse(raw));
  } catch {
    return emptyMemory();
  }
}

async function writeMemory(memory) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const compacted = compactMemoryObject(ensureMemoryShape(memory));
  await fs.writeFile(memoryFile, `${JSON.stringify(compacted, null, 2)}\n`, "utf8");
}

function projectKey(projectDir) {
  return path.resolve(String(projectDir || "")).toLowerCase();
}

function sameProject(left, right) {
  return Boolean(left && right && projectKey(left) === projectKey(right));
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function sameFile(left, right) {
  return normalizeRelativePath(left).toLowerCase() === normalizeRelativePath(right).toLowerCase();
}

function isAfterProjectOpened(memory, item) {
  const state = sessionState(memory);
  const openedAt = Date.parse(state.last?.activeProjectOpenedAt || "");
  if (!Number.isFinite(openedAt)) return true;

  const itemTime = Date.parse(item?.ts || "");
  if (!Number.isFinite(itemTime)) return true;
  return itemTime >= openedAt;
}

function resolveProjectFile(projectDir, filePath) {
  const resolved = path.resolve(projectDir, normalizeRelativePath(filePath));
  const relative = path.relative(path.resolve(projectDir), resolved);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) return null;
  return resolved;
}

async function getFileState(projectDir, filePath) {
  const absolutePath = resolveProjectFile(projectDir, filePath);
  if (!absolutePath) return null;

  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) return null;

  return {
    filePath: normalizeRelativePath(path.relative(projectDir, absolutePath)),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

function isExpired(ts) {
  return !ts || Date.now() - Number(ts) > pendingTtlMs;
}

function pendingStillMatchesFile(pending, fileState) {
  if (!fileState) return false;
  if (pending.size !== undefined && pending.size !== fileState.size) return false;
  if (pending.modifiedAt && pending.modifiedAt !== fileState.modifiedAt) return false;
  if (pending.baseSize !== undefined && pending.baseSize !== fileState.size) return false;
  if (pending.baseModifiedAt && pending.baseModifiedAt !== fileState.modifiedAt) return false;
  return true;
}

function clearPendingForPath(memory, projectDir, filePath) {
  const state = sessionState(memory);
  let changed = false;
  for (const [userId, pending] of Object.entries(state.pending.edits || {})) {
    if (sameProject(pending?.projectDir, projectDir) && sameFile(pending?.filePath, filePath)) {
      delete state.pending.edits[userId];
      changed = true;
    }
  }
  for (const [userId, pending] of Object.entries(state.pending.deletes || {})) {
    if (sameProject(pending?.projectDir, projectDir) && sameFile(pending?.filePath, filePath)) {
      delete state.pending.deletes[userId];
      changed = true;
    }
  }
  return changed;
}

export async function compactMemory() {
  const memory = await readMemory();
  await writeMemory(memory);
  return getMemorySummary();
}

export async function syncMemoryForProject(projectDir) {
  const memory = await readMemory();
  const state = sessionState(memory);
  let changed = false;
  const activeProjectOpenedAt = state.last.activeProjectOpenedAt || "";

  if (activeProjectOpenedAt && state.last.syncedProjectOpenedAt !== activeProjectOpenedAt) {
    for (const key of [
      "command",
      "error",
      "search",
      "filePath",
      "fileProjectDir",
      "fileUpdatedAt",
      "deletedFilePath",
      "deletedFileProjectDir",
      "deletedAt"
    ]) {
      delete state.last[key];
    }
    state.last.syncedProjectOpenedAt = activeProjectOpenedAt;
    changed = true;
  }

  if (state.last.filePath) {
    const lastFileState = await getFileState(projectDir, state.last.filePath);
    const shouldClearLastFile =
      !sameProject(state.last.fileProjectDir || projectDir, projectDir) ||
      !lastFileState;

    if (shouldClearLastFile) {
      delete state.last.filePath;
      delete state.last.fileProjectDir;
      delete state.last.fileUpdatedAt;
      changed = true;
    } else if (!state.last.fileProjectDir || !state.last.fileUpdatedAt) {
      state.last.filePath = lastFileState.filePath;
      state.last.fileProjectDir = path.resolve(projectDir);
      state.last.fileUpdatedAt = lastFileState.modifiedAt;
      changed = true;
    }
  }

  const latestCommandTask = [...(state.tasks || [])]
    .reverse()
    .find((task) => sameProject(task.projectDir, projectDir) && ["run", "shell"].includes(task.type) && task.command);
  if (state.last.error && latestCommandTask && ["done", "success"].includes(latestCommandTask.status)) {
    delete state.last.error;
    changed = true;
  }

  for (const [userId, pending] of Object.entries(state.pending.edits || {})) {
    const stale =
      !pending ||
      isExpired(pending.createdAt) ||
      !sameProject(pending.projectDir, projectDir);

    if (stale) {
      delete state.pending.edits[userId];
      changed = true;
      continue;
    }

    const fileState = await getFileState(projectDir, pending.filePath);
    const createConflict = pending.type === "create" && fileState;
    const editMismatch = pending.type !== "create" && !pendingStillMatchesFile(pending, fileState);
    if (createConflict || editMismatch) {
      delete state.pending.edits[userId];
      changed = true;
    }
  }

  for (const [userId, pending] of Object.entries(state.pending.deletes || {})) {
    const fileState = pending ? await getFileState(projectDir, pending.filePath) : null;
    const stale =
      !pending ||
      isExpired(pending.createdAt) ||
      !sameProject(pending.projectDir, projectDir) ||
      !pendingStillMatchesFile(pending, fileState);

    if (stale) {
      delete state.pending.deletes[userId];
      changed = true;
    }
  }

  if (changed) await writeMemory(memory);
  return memory;
}

export async function recordFileOpen({ projectDir, filePath }) {
  const memory = await readMemory();
  const state = sessionState(memory);
  const fileState = await getFileState(projectDir, filePath);
  if (!fileState) return null;

  state.last.filePath = fileState.filePath;
  state.last.fileProjectDir = path.resolve(projectDir);
  state.last.fileUpdatedAt = fileState.modifiedAt;
  await writeMemory(memory);
  return fileState;
}

export async function recordFileMutation({ projectDir, filePath, action }) {
  const memory = await readMemory();
  const state = sessionState(memory);
  const normalizedPath = normalizeRelativePath(filePath);

  clearPendingForPath(memory, projectDir, normalizedPath);

  if (action === "delete") {
    if (sameProject(state.last.fileProjectDir || projectDir, projectDir) && sameFile(state.last.filePath, normalizedPath)) {
      delete state.last.filePath;
      delete state.last.fileProjectDir;
      delete state.last.fileUpdatedAt;
    }
    state.last.deletedFilePath = normalizedPath;
    state.last.deletedFileProjectDir = path.resolve(projectDir);
    state.last.deletedAt = nowIso();
    await writeMemory(memory);
    return null;
  }

  const fileState = await getFileState(projectDir, normalizedPath);
  if (fileState) {
    state.last.filePath = fileState.filePath;
    state.last.fileProjectDir = path.resolve(projectDir);
    state.last.fileUpdatedAt = fileState.modifiedAt;
  }
  await writeMemory(memory);
  return fileState;
}

export async function getMemorySummary(projectDir = "") {
  const memory = projectDir ? await syncMemoryForProject(projectDir) : await readMemory();
  const state = sessionState(memory);
  const projectId = projectDir ? normalizeProjectKey(projectDir) : "";
  const projectFacts = projectId ? (memory.projectFacts[projectId] || memory.projectFacts[projectDir] || []) : [];
  const last = state.last || {};
  const lastFile = projectDir && sameProject(last.fileProjectDir || projectDir, projectDir) ? last.filePath : "";

  return [
    projectDir ? `Project aktif: ${projectDir}` : null,
    memory.preferences?.length ? `Preferensi:\n- ${memory.preferences.slice(-10).join("\n- ")}` : null,
    Object.keys(memory.environment || {}).length ? `Environment:\n${Object.entries(memory.environment).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join("\n")}` : null,
    Array.isArray(projectFacts) && projectFacts.length ? `Project facts:\n- ${projectFacts.slice(-10).join("\n- ")}` : null,
    memory.corrections?.length ? `Corrections:\n- ${memory.corrections.slice(-8).join("\n- ")}` : null,
    last.command ? `Command terakhir: ${last.command}` : null,
    last.error ? `Error terakhir: ${truncateOutput(last.error, 800)}` : null,
    lastFile ? `File terakhir: ${lastFile}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export async function getConversationContext({ projectDir = null, maxItems = 10, maxChars = 6000 } = {}) {
  const memory = await readMemory();
  const state = sessionState(memory);
  const scoped = projectDir
    ? (state.conversations || []).filter((item) => sameProject(item.projectDir, projectDir))
    : (state.conversations || []);
  const recent = scoped.filter((item) => isAfterProjectOpened(memory, item)).slice(-maxItems);
  if (recent.length === 0) return [];

  let totalChars = 0;
  const messages = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    const text = item.text || "";
    if (totalChars + text.length > maxChars) break;
    totalChars += text.length;
    messages.unshift({
      role: item.role === "assistant" ? "assistant" : "user",
      text
    });
  }
  return messages;
}

export async function getRecentTasks({ projectDir = null, maxItems = 8 } = {}) {
  const memory = await readMemory();
  const state = sessionState(memory);
  const scoped = projectDir
    ? (state.tasks || []).filter((task) => sameProject(task.projectDir, projectDir))
    : (state.tasks || []);
  const filtered = [];
  for (const task of scoped) {
    if (!isAfterProjectOpened(memory, task)) continue;
    if (projectDir && task.filePath && task.type !== "delete" && !(await getFileState(projectDir, task.filePath))) continue;
    filtered.push(task);
  }
  const recent = filtered.slice(-maxItems);
  if (recent.length === 0) return "";

  return recent.map((task) => {
    const parts = [
      `[${task.ts}] ${task.type}`,
      task.filePath ? `file: ${task.filePath}` : null,
      task.command ? `cmd: ${task.command}` : null,
      task.summary ? `summary: ${truncateOutput(task.summary, 200)}` : null,
      `status: ${task.status}`
    ].filter(Boolean);
    return parts.join(" | ");
  }).join("\n");
}

export async function savePreference(text) {
  const memory = await readMemory();
  const preference = sanitizeText(text, 1000);
  if (!preference) throw new Error("Isi memory tidak boleh kosong.");
  memory.preferences = dedupeAppend(memory.preferences, preference, 50);
  await writeMemory(memory);
  return preference;
}

export async function rememberPreference(text) {
  return savePreference(text);
}

export async function saveCorrection(text) {
  const memory = await readMemory();
  const correction = sanitizeText(text, 1000);
  if (!correction) throw new Error("Correction kosong.");
  memory.corrections = dedupeAppend(memory.corrections, correction, 50);
  await writeMemory(memory);
  return correction;
}

export async function saveProjectFact(projectDir, fact = "") {
  const memory = await readMemory();
  const project = fact ? normalizeProjectKey(projectDir) : "global";
  const text = sanitizeText(fact || projectDir, 1200);
  if (!text) throw new Error("Project fact kosong.");
  const current = Array.isArray(memory.projectFacts[project]) ? memory.projectFacts[project] : [];
  memory.projectFacts[project] = dedupeAppend(current, text, 80);
  await writeMemory(memory);
  return text;
}

export async function saveEnvironmentFact(key, value = "") {
  const memory = await readMemory();
  const safeKey = normalizeKey(key).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  if (!safeKey) throw new Error("Environment key kosong.");
  const safeValue = sanitizeText(value, 1000);
  memory.environment[safeKey] = safeValue;
  await writeMemory(memory);
  return { key: safeKey, value: safeValue };
}

export async function forgetMemory(query = "", category = "all") {
  const memory = await readMemory();
  const needle = String(query || "").trim().toLowerCase();
  const targetCategory = String(category || "all").toLowerCase();
  let removed = 0;

  const filterList = (list) => {
    const before = list || [];
    if (!needle || needle === "all" || needle === "semua") {
      removed += before.length;
      return [];
    }
    const after = before.filter((item) => !String(item).toLowerCase().includes(needle));
    removed += before.length - after.length;
    return after;
  };

  if (targetCategory === "all" || targetCategory === "preferences") {
    memory.preferences = filterList(memory.preferences);
  }
  if (targetCategory === "all" || targetCategory === "corrections") {
    memory.corrections = filterList(memory.corrections);
  }
  if (targetCategory === "all" || targetCategory === "workflows") {
    memory.workflows = Array.isArray(memory.workflows) ? filterList(memory.workflows.map((w) => JSON.stringify(w))).map((w) => JSON.parse(w)) : [];
  }
  if (targetCategory === "all" || targetCategory === "environment") {
    for (const key of Object.keys(memory.environment || {})) {
      if (!needle || needle === "all" || key.toLowerCase().includes(needle) || String(memory.environment[key]).toLowerCase().includes(needle)) {
        delete memory.environment[key];
        removed += 1;
      }
    }
  }
  if (targetCategory === "all" || targetCategory === "projectfacts" || targetCategory === "projectFacts") {
    for (const key of Object.keys(memory.projectFacts || {})) {
      const before = Array.isArray(memory.projectFacts[key]) ? memory.projectFacts[key] : [];
      memory.projectFacts[key] = filterList(before);
      if (!memory.projectFacts[key].length) delete memory.projectFacts[key];
    }
  }

  await writeMemory(memory);
  return removed;
}

export async function forgetPreference(query = "") {
  return forgetMemory(query, "preferences");
}

export async function rememberConversation({ userId, role, text, projectDir }) {
  const memory = await readMemory();
  const state = sessionState(memory);
  const safeText = truncateOutput(redactSecrets(String(text || "")), 2000);
  if (!safeText || /\[REDACTED/i.test(safeText)) return;
  state.conversations.push({
    ts: nowIso(),
    userId: String(userId || ""),
    role,
    projectDir,
    text: safeText
  });
  state.conversations = state.conversations.slice(-maxConversationItems);
  await writeMemory(memory);
}

export async function setLast(key, value) {
  const memory = await readMemory();
  const state = sessionState(memory);
  state.last[key] = sanitizeLoose(value, 6000);
  await writeMemory(memory);
}

export async function getLast(key) {
  const memory = await readMemory();
  return sessionState(memory).last?.[key];
}

export async function updateProjectProfile(projectDir, profile) {
  const memory = await readMemory();
  const project = normalizeProjectKey(projectDir);
  const current = Array.isArray(memory.projectFacts[project]) ? memory.projectFacts[project] : [];
  const facts = [];
  for (const [key, value] of Object.entries(profile || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "updatedAt") continue;
    facts.push(`${key}: ${String(value)}`);
  }
  memory.projectFacts[project] = [...new Set([...current, ...ensureStringArray(facts)])].slice(-80);
  await writeMemory(memory);
}

export async function setPendingEdit(userId, pending) {
  const memory = await readMemory();
  const state = sessionState(memory);
  const fileState = pending?.type === "create" ? null : await getFileState(pending.projectDir, pending.filePath);
  state.pending.edits[String(userId)] = sanitizeLoose({
    ...pending,
    baseSize: fileState?.size,
    baseModifiedAt: fileState?.modifiedAt
  }, 12000);
  await writeMemory(memory);
}

export async function getPendingEdit(userId) {
  const memory = await readMemory();
  return sessionState(memory).pending.edits[String(userId)] || null;
}

export async function clearPendingEdit(userId) {
  const memory = await readMemory();
  delete sessionState(memory).pending.edits[String(userId)];
  await writeMemory(memory);
}

export async function setPendingDelete(userId, pending) {
  const memory = await readMemory();
  sessionState(memory).pending.deletes[String(userId)] = sanitizeLoose(pending, 4000);
  await writeMemory(memory);
}

export async function getPendingDelete(userId) {
  const memory = await readMemory();
  return sessionState(memory).pending.deletes[String(userId)] || null;
}

export async function clearPendingDelete(userId) {
  const memory = await readMemory();
  delete sessionState(memory).pending.deletes[String(userId)];
  await writeMemory(memory);
}

export async function recordBackup(entry) {
  const memory = await readMemory();
  const state = sessionState(memory);
  state.backups.push({
    ts: nowIso(),
    ...sanitizeLoose(entry, 4000)
  });
  state.backups = state.backups.slice(-100);
  await writeMemory(memory);
}

export async function getLastBackup(projectDir, filePath = null) {
  const memory = await readMemory();
  const backups = sessionState(memory).backups || [];
  return [...backups]
    .reverse()
    .find((entry) => entry.projectDir === projectDir && (!filePath || entry.filePath === filePath)) || null;
}

export async function recordTask(entry) {
  const memory = await readMemory();
  const state = sessionState(memory);
  state.tasks.push({
    ts: nowIso(),
    ...sanitizeLoose(entry, 1200)
  });
  state.tasks = state.tasks.slice(-maxTaskItems);
  await writeMemory(memory);
}

export async function getMemoryForDebug() {
  const memory = await readMemory();
  const state = sessionState(memory);
  const safe = {
    version: memory.version,
    preferences: memory.preferences,
    environment: memory.environment,
    projectFacts: memory.projectFacts,
    corrections: memory.corrections,
    workflows: memory.workflows,
    sessionState: {
      last: state.last,
      pending: {
        edits: Object.keys(state.pending.edits || {}),
        deletes: Object.keys(state.pending.deletes || {})
      },
      backups: (state.backups || []).slice(-10),
      conversationCount: (state.conversations || []).length,
      taskCount: (state.tasks || []).length,
      recentTasks: (state.tasks || []).slice(-10)
    }
  };
  return truncateOutput(JSON.stringify(safe, null, 2), config.maxOutputChars);
}

export async function getPreferencesText() {
  const memory = await readMemory();
  const preferences = memory.preferences || [];
  if (!preferences.length) return "Belum ada preferensi yang disimpan.";
  return preferences.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export async function clearSessionData({ preserveActivePaths = true } = {}) {
  const memory = await readMemory();
  const state = sessionState(memory);
  state.last = preserveActivePaths
    ? {
        activeWorkspaceDir: state.last.activeWorkspaceDir,
        activeProjectDir: state.last.activeProjectDir,
        activeProjectOpenedAt: state.last.activeProjectOpenedAt
      }
    : {};
  state.pending = { edits: {}, deletes: {} };
  state.conversations = [];
  state.tasks = [];
  await writeMemory(memory);
}

export async function clearConversationHistory() {
  const memory = await readMemory();
  sessionState(memory).conversations = [];
  await writeMemory(memory);
}
