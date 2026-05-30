import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { config, getMissingConfigKeys, setAiProvider } from "../core/config.js";
import { chat, askProjectQuestion, askGeneralQuestion, classifyNaturalLanguageIntent, proposeFileEdit, proposeFileFix, proposeNewFile, transcribeAudio, aiEvents, readAgentInstructions } from "../ai/ai.js";
import { isAutonomousRequest, planAutonomousAction, generateFileContent, safeReadFile, runToolCallingAgent } from "../ai/agent.js";
import { checkKiroCli } from "../ai/extraCliProviders.js";
import { detectAntigravity, describeAntigravityStatus, openProjectInAntigravity } from "../system/antigravity.js";
import {
  backupProjectFile,
  createPreview,
  createProjectFile,
  deleteProjectFileWithBackup,
  getProjectContext,
  getProjectFileInfo,
  listProjectTree,
  readProjectFile,
  restoreProjectFileFromBackup,
  writeProjectFileWithBackup
} from "../utils/fileManager.js";
import { createUnifiedDiff } from "../utils/diff.js";
import { logger } from "../core/logger.js";
import { printTerminalBanner } from "../core/bot.js";
import {
  clearPendingDelete,
  clearPendingEdit,
  forgetPreference,
  getLast,
  getLastBackup,
  getMemoryForDebug,
  getMemorySummary,
  getPendingDelete,
  getPendingEdit,
  getPreferencesText,
  getRecentTasks,
  forgetMemory,
  recordFileMutation,
  recordFileOpen,
  recordBackup,
  recordTask,
  rememberConversation,
  rememberPreference,
  saveCorrection,
  saveEnvironmentFact,
  saveProjectFact,
  savePreference,
  setLast,
  setPendingDelete,
  syncMemoryForProject,
  updateProjectProfile,
  clearConversationHistory,
  clearSessionData
} from "../core/memory.js";
import { deleteSkill, formatSkill, getSkill, listSkills, saveSkillFromLastWorkflow } from "../core/skills.js";
import { formatSearchResults, inferFileFromText, searchProject } from "../utils/search.js";
import {
  checkRateLimit,
  formatRetryAfter,
  getDestructiveCommandReason,
  isAdminUser,
  parseCommandLine,
  redactSecrets,
  truncateOutput
} from "../utils/security.js";
import {
  T,
  divider,
  header,
  kv,
  badge,
  bullets,
  card,
  stats,
  code,
  breadcrumb,
  suggestionChips,
  truncMid,
  compose
} from "../utils/uiTheme.js";
import {
  ensureActiveProject,
  getActiveProjectDir,
  getActiveProjectName,
  getActiveProjectPath,
  getProcessStatusText,
  getWorkspaceDir,
  listAvailableDrives,
  listProjects,
  stopAllProcesses,
  stopProcess,
  switchWorkspace,
  switchProject,
  listRunningProcesses
} from "../system/processManager.js";
import { readCommandLogs, restartDevServer, runCommand, runShellCommand } from "../system/terminal.js";
import { captureDesktopScreenshot, closeDesktopApp, listActiveDesktopApps, listLaunchableApps, openDesktopApp, openUrl, isBrowserApp, detectBrowserExe, adjustVolume, controlMedia, runPowerShell } from "../system/laptopRemote.js";
import {
  listConnectors,
  listActiveConnectors,
  testConnector,
  statusConnector,
  refreshConnector,
  executeAction,
  approveById,
  rejectById,
  findApproval,
  resolveServiceId,
  getConnector,
  formatApprovalMessage,
  requiresApproval
} from "../connectors/connectorManager.js";
import { createApproval, listPending } from "../connectors/approvalPolicy.js";
import {
  startDeviceFlow,
  pollForToken,
  persistTokenToEnv,
  trackSession as trackLoginSession,
  getSession as getLoginSession,
  clearSession as clearLoginSession
} from "../connectors/githubDeviceLogin.js";
import { ensureGitRepo, parseGithubRemote } from "../utils/git.js";
import ngrok from "@ngrok/ngrok";

const activeTunnels = new Map();
const browserUrlMode = new Map();
const browserSearchMode = new Map();
let lastMinimizedHwnd = null;

function detectDevServerPort(output) {
  const text = String(output || "");
  const urlMatch = text.match(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[:/](\d{2,5})/i);
  const labelMatch = text.match(/\b(?:port|PORT|Local|Network|ready on|listening on)\D{0,30}(\d{2,5})\b/i);
  const port = Number(urlMatch?.[1] || labelMatch?.[1]);

  if (!Number.isInteger(port) || port < 1 || port > 65535) return "";
  return String(port);
}

async function openPublicTunnel(port, msg) {
  const normalizedPort = Number(port) || 3000;

  if (!process.env.NGROK_AUTHTOKEN) {
    throw new Error(
      "NGROK_AUTHTOKEN belum disetting di file .env.\n" +
      "Ngrok membutuhkan authtoken. Daftar di https://dashboard.ngrok.com/signup lalu tambahkan NGROK_AUTHTOKEN=xxxx ke .env kamu."
    );
  }

  // Bebaskan semua tunnel lama (karena akun gratis hanya mendukung 1 endpoint aktif)
  await closePublicTunnels();

  const listener = await ngrok.forward({
    addr: `127.0.0.1:${normalizedPort}`,
    authtoken_from_env: true
  });

  activeTunnels.set(normalizedPort, listener);

  return { url: listener.url(), port: normalizedPort };
}

async function closePublicTunnels(port = null) {
  if (port !== null && port !== undefined && activeTunnels.has(Number(port))) {
    const listener = activeTunnels.get(Number(port));
    await listener.close().catch(() => {});
    activeTunnels.delete(Number(port));
    return;
  }

  for (const listener of activeTunnels.values()) {
    await listener.close().catch(() => {});
  }
  activeTunnels.clear();
}

async function autoGitCommit(projectDir, message) {
  try {
    await runCommand(`git add .`, projectDir);
    await runCommand(`git commit -m "AI Update: ${message.replace(/"/g, '\\"')}"`, projectDir);
  } catch (e) {
    // Ignore if not a git repo or no changes
  }
}

const pendingEdits = new Map();
const pendingDeletes = new Map();
const pendingTtlMs = 30 * 60 * 1000;

// Shell mode state per user — when active, all messages are executed as shell commands
const shellModeUsers = new Set();
// Per-user shell pilihan untuk shell mode (powershell | cmd | bash). Default
// fallback ke config.defaultShell kalau user belum override.
const shellPreference = new Map();

// Active agent sessions: chatId -> { abort, label, startedAt }
const activeAgentSessions = new Map();

// Last natural-language request per user for /retry
const lastUserRequest = new Map();

// Engine custom-model input mode: chatId -> { provider, ts }
const engineCustomMode = new Map();

// Engine model registry: short id -> { provider, model }.
// Telegram membatasi callback_data 64 byte. Banyak model id cukup panjang
// (mis. "gemini-2.5-pro-preview-tts"), jadi
// kita pakai numeric id dan resolve di handler. Registry di-rebuild tiap kali
// /engine dirender supaya tetap konsisten kalau daftar provider berubah.
const engineModelRegistry = new Map(); // id -> { provider, model }
const engineModelReverse = new Map();  // "provider::model" -> id
let engineModelSeq = 0;

function registerEngineModel(provider, model) {
  const key = `${provider}::${model}`;
  const existing = engineModelReverse.get(key);
  if (existing) return existing;
  const id = `m${engineModelSeq++}`;
  engineModelRegistry.set(id, { provider, model });
  engineModelReverse.set(key, id);
  return id;
}

function resolveEngineModel(id) {
  return engineModelRegistry.get(id) || null;
}

// Satu pending edit per admin menjaga alur preview -> confirm tetap eksplisit.
function getCommandParts(text) {
  const trimmed = String(text || "").trim();
  const [rawCommand = ""] = trimmed.split(/\s+/, 1);
  const command = rawCommand.split("@")[0].toLowerCase();
  const args = trimmed.slice(rawCommand.length).trim();
  return { command, args };
}

function splitPathAndInstruction(args) {
  const tokens = parseCommandLine(args);
  if (tokens.length < 2) throw new Error("Format: <path/file> <instruksi atau error>");
  return {
    filePath: tokens[0],
    instruction: tokens.slice(1).join(" ")
  };
}

function getReplyText(msg) {
  const replyMessage = msg.reply_to_message;
  if (!replyMessage) return "";
  return redactSecrets(replyMessage.text || replyMessage.caption || "").trim();
}

function splitFixArgs(args, msg) {
  const tokens = parseCommandLine(args);
  const replyText = getReplyText(msg);

  if (tokens.length < 1 && !replyText) {
    throw new Error("Format: /fix path/file.js error. Bisa juga reply pesan error lalu kirim /fix path/file.js.");
  }

  if (tokens.length === 1 && !replyText) {
    throw new Error("Kirim error setelah path, atau reply pesan error lalu kirim /fix path/file.js.");
  }

  const inlineInstruction = tokens.slice(1).join(" ").trim();
  const instructionParts = [];
  if (inlineInstruction) instructionParts.push(`Instruksi user:\n${inlineInstruction}`);
  if (replyText) instructionParts.push(`Pesan error/output yang direply:\n${truncateOutput(replyText, 12000)}`);

  return {
    filePath: tokens[0] || "",
    instruction: instructionParts.join("\n\n")
  };
}

function parseSingleArgument(args, usage) {
  const tokens = parseCommandLine(args);
  if (tokens.length !== 1) throw new Error(usage);
  return tokens[0];
}

async function sendTyping(bot, chatId) {
  await bot.sendChatAction(chatId, "typing").catch(() => {});
}

async function progress(bot, msg, text) {
  await sendTyping(bot, msg.chat.id);
  await bot.sendMessage(msg.chat.id, redactSecrets(String(text || "")), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * Live progress: kirim message awal lalu return updater yang ngedit message itu.
 * Updater rate-limited internal supaya gak kena Telegram API limit (max 1 edit / 1.5s).
 *
 *   const live = await liveProgress(bot, msg, "🧠 Thinking...");
 *   await live.update("🧠 Reading file 1/5...");
 *   await live.update("✅ Done", { final: true });
 *
 * Kalau Telegram nolak edit (message terlalu lama / chat dihapus), fallback ke sendMessage baru.
 */
async function liveProgress(bot, msg, initialText, { interval = 1500 } = {}) {
  let messageId = null;
  let lastSentAt = 0;
  let lastText = "";
  let pendingText = null;
  let pendingTimer = null;

  const trySend = async (chatId, text) => {
    // Try Markdown with balancing first; on parse error, fallback to plain.
    const balanced = balanceMarkdown(text);
    try {
      return await bot.sendMessage(chatId, balanced, { parse_mode: "Markdown" });
    } catch (err) {
      if (/can't parse entities|parse_mode|MARKDOWN/i.test(err?.message || "")) {
        const plain = balanced
          .replace(/\\([_*`\[\]])/g, "$1")
          .replace(/```[a-z]*\n?/gi, "")
          .replace(/```/g, "")
          .replace(/`/g, "")
          .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2")
          .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2");
        return bot.sendMessage(chatId, plain);
      }
      throw err;
    }
  };

  const tryEdit = async (chatId, mid, text) => {
    const balanced = balanceMarkdown(text);
    try {
      return await bot.editMessageText(balanced, {
        chat_id: chatId,
        message_id: mid,
        parse_mode: "Markdown"
      });
    } catch (err) {
      if (/can't parse entities|parse_mode|MARKDOWN/i.test(err?.message || "")) {
        const plain = balanced
          .replace(/\\([_*`\[\]])/g, "$1")
          .replace(/```[a-z]*\n?/gi, "")
          .replace(/```/g, "")
          .replace(/`/g, "")
          .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2")
          .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2");
        return bot.editMessageText(plain, { chat_id: chatId, message_id: mid });
      }
      throw err;
    }
  };

  const send = async (text) => {
    const safeText = redactSecrets(String(text || ""));
    if (safeText === lastText) return;
    if (!messageId) {
      try {
        const sent = await trySend(msg.chat.id, safeText);
        messageId = sent.message_id;
        lastText = safeText;
        lastSentAt = Date.now();
      } catch {
        // ignore
      }
      return;
    }
    try {
      await tryEdit(msg.chat.id, messageId, safeText);
      lastText = safeText;
      lastSentAt = Date.now();
    } catch (err) {
      if (!/message is not modified/i.test(err.message || "")) {
        try {
          const sent = await trySend(msg.chat.id, safeText);
          messageId = sent.message_id;
          lastText = safeText;
          lastSentAt = Date.now();
        } catch {}
      }
    }
  };

  await send(initialText);

  return {
    async update(text, { final = false } = {}) {
      if (final) {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = null;
        pendingText = null;
        await send(text);
        return;
      }
      pendingText = text;
      const elapsed = Date.now() - lastSentAt;
      if (elapsed >= interval) {
        await send(pendingText);
        pendingText = null;
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(async () => {
          pendingTimer = null;
          if (pendingText !== null) {
            const t = pendingText;
            pendingText = null;
            await send(t);
          }
        }, interval - elapsed);
      }
    },
    async finish(text) {
      await this.update(text, { final: true });
    },
    get messageId() { return messageId; }
  };
}

/**
 * Balance Telegram Markdown V1 entities supaya tidak bikin parse error.
 * Telegram Markdown V1 sensitive ke `_ * [ \`` yang tidak ditutup.
 *
 * Strategi: hitung jumlah masing-masing token; kalau ganjil, escape semua
 * occurrence dengan backslash. Untuk backtick, kita cukup hitung pasangan.
 */
function balanceMarkdown(text) {
  let s = String(text ?? "");

  // 1. Backticks: pastikan code-block fence (```), then inline backtick balance.
  // Hitung triple-backtick fence — kalau ganjil, tambahkan satu di akhir.
  const fences = (s.match(/```/g) || []).length;
  if (fences % 2 !== 0) s += "\n```";

  // 2. Inline backtick balance (di luar code block sulit, tapi simpel: hitung
  // total ` di luar fenced regions).
  // Strip fenced regions sementara untuk hitung inline.
  const fencedSpans = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    fencedSpans.push(m);
    return `\u0001FENCE${fencedSpans.length - 1}\u0001`;
  });

  const inlineBacktickCount = (s.match(/`/g) || []).length;
  if (inlineBacktickCount % 2 !== 0) {
    // Escape SEMUA inline backtick agar Telegram tidak coba parse.
    s = s.replace(/`/g, "\\`");
  }

  // 3. Balance `*` (bold): kalau jumlah tidak even, escape semua.
  const stars = (s.match(/\*/g) || []).length;
  if (stars % 2 !== 0) {
    s = s.replace(/\*/g, "\\*");
  }

  // 4. Balance `_` (italic): hitung underscore yang berdiri sendiri (bukan
  // bagian dari identifier). Conservative: kalau ganjil, escape semua.
  const underscores = (s.match(/_/g) || []).length;
  if (underscores % 2 !== 0) {
    s = s.replace(/_/g, "\\_");
  }

  // 5. Square bracket: kalau `[` tidak diikuti `]` proper, escape orphan brackets.
  const opens = (s.match(/\[/g) || []).length;
  const closes = (s.match(/\]/g) || []).length;
  if (opens !== closes) {
    s = s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  }

  // Restore fenced spans
  s = s.replace(/\u0001FENCE(\d+)\u0001/g, (_, i) => fencedSpans[Number(i)]);

  return s;
}

export async function sendLongMessage(bot, chatId, text, options = {}) {
  const safeText = redactSecrets(String(text || "(kosong)"));
  const limit = config.telegramMessageLimit;
  const isMarkdown = (options.parse_mode === "Markdown" || options.parse_mode === "MarkdownV2");
  const chunks = [];

  for (let index = 0; index < safeText.length; index += limit) {
    chunks.push(safeText.slice(index, index + limit));
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const prefix = chunks.length > 1 ? `[${index + 1}/${chunks.length}]\n` : "";
    let body = `${prefix}${chunks[index]}`;
    if (isMarkdown) body = balanceMarkdown(body);
    try {
      await bot.sendMessage(chatId, body, options);
    } catch (err) {
      // Markdown parse error fallback: re-send as plain text without parse_mode
      if (isMarkdown && /can't parse entities|parse_mode|MARKDOWN/i.test(err?.message || "")) {
        const fallback = { ...options };
        delete fallback.parse_mode;
        // Strip markdown emphasis chars but keep code blocks readable
        const plain = body
          .replace(/\\([_*`\[\]])/g, "$1")
          .replace(/```[a-z]*\n?/gi, "")
          .replace(/```/g, "")
          .replace(/`/g, "")
          .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2")
          .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2");
        try {
          await bot.sendMessage(chatId, plain, fallback);
        } catch (err2) {
          await logger.error("sendLongMessage fallback failed", { error: err2.message });
        }
      } else {
        throw err;
      }
    }
  }
}

async function reply(bot, msg, text, options = {}) {
  await sendLongMessage(bot, msg.chat.id, text, options);
}

const projectSelections = new Map();
let projectSelectionCounter = 0;
const projectSelectionTtlMs = 10 * 60 * 1000;

function cleanupProjectSelections() {
  const now = Date.now();
  for (const [token, selection] of projectSelections.entries()) {
    if (now - selection.ts > projectSelectionTtlMs) projectSelections.delete(token);
  }
}

function createProjectCallback(projectName) {
  cleanupProjectSelections();
  const token = `p${Date.now().toString(36)}${(projectSelectionCounter++).toString(36)}`;
  projectSelections.set(token, { name: projectName, ts: Date.now() });
  return `switch_proj_pick_${token}`;
}

const folderSelections = new Map();
let folderSelectionCounter = 0;
const folderSelectionTtlMs = 10 * 60 * 1000;

function cleanupFolderSelections() {
  const now = Date.now();
  for (const [token, selection] of folderSelections.entries()) {
    if (now - selection.ts > folderSelectionTtlMs) folderSelections.delete(token);
  }
}

function createFolderCallback(kind, folderPath) {
  cleanupFolderSelections();
  const token = `f${Date.now().toString(36)}${(folderSelectionCounter++).toString(36)}`;
  folderSelections.set(token, { kind, path: folderPath, ts: Date.now() });
  return `folder_${kind}_${token}`;
}

const desktopAppSelections = new Map();
let desktopAppSelectionCounter = 0;
const desktopAppSelectionTtlMs = 10 * 60 * 1000;

function cleanupDesktopAppSelections() {
  const now = Date.now();
  for (const [token, selection] of desktopAppSelections.entries()) {
    if (now - selection.ts > desktopAppSelectionTtlMs) desktopAppSelections.delete(token);
  }
}

function createDesktopAppCallback(kind, payload) {
  cleanupDesktopAppSelections();
  const token = `a${Date.now().toString(36)}${(desktopAppSelectionCounter++).toString(36)}`;
  desktopAppSelections.set(token, { kind, payload, ts: Date.now() });
  return `desktop_${kind}_${token}`;
}

const safeActionSelections = new Map();
let safeActionCounter = 0;
const safeActionTtlMs = 10 * 60 * 1000;

function cleanupSafeActionSelections() {
  const now = Date.now();
  for (const [token, selection] of safeActionSelections.entries()) {
    if (now - selection.ts > safeActionTtlMs) safeActionSelections.delete(token);
  }
}

function createSafeActionCallback(kind, payload) {
  cleanupSafeActionSelections();
  const token = `s${Date.now().toString(36)}${(safeActionCounter++).toString(36)}`;
  safeActionSelections.set(token, { kind, payload, ts: Date.now() });
  return `safe_confirm_${token}`;
}

async function isSafeModeEnabled() {
  return (await getLast("safeMode")) !== false;
}

function actionKeyboard(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows
    }
  };
}

function workspaceDriveRows(drives, currentWorkspace = "") {
  const current = String(currentWorkspace || "").toLowerCase();
  return drives.map((drive) => {
    const letter = drive.slice(0, 1).toUpperCase();
    const active = current.startsWith(`${letter.toLowerCase()}:\\`) || current.startsWith(`${letter.toLowerCase()}:/`);
    return [{ text: `${active ? "ACTIVE " : ""}${letter}:/`, callback_data: `switch_ws_${letter}` }];
  });
}

function projectRows(projects, currentProjectName = "") {
  return projects.map((name) => {
    const active = name === currentProjectName;
    return [{ text: `${active ? "ACTIVE " : ""}${name}`, callback_data: createProjectCallback(name) }];
  });
}

function folderRows(folders, currentDir = "") {
  return folders.map((name) => {
    const folderPath = path.join(currentDir, name);
    const isProject = looksLikeProjectFolder(folderPath);
    const shortName = name.length > 15 ? name.slice(0, 12) + "..." : name;
    return [
      { text: `📂 Buka ${shortName}`, callback_data: createFolderCallback("browse", folderPath) },
      { text: `✅ Pilih Sbg Project`, callback_data: createFolderCallback("activate", folderPath) }
    ];
  });
}

function workspaceKeyboard({ drives = [], projects = [], currentWorkspace = "", currentProjectName = "" } = {}) {
  const rows = [];
  const driveRows = workspaceDriveRows(drives, currentWorkspace);
  if (driveRows.length) rows.push(...driveRows);
  const folderButtons = folderRows(projects, currentWorkspace);
  if (folderButtons.length) {
    rows.push([{ text: "-- Isi folder saat ini --", callback_data: "noop" }]);
    rows.push(...folderButtons.slice(0, 35));
  }
  if (!rows.length) return {};
  return actionKeyboard(rows);
}


function deletePreviewKeyboard() {
  return actionKeyboard([
    [
      { text: "Confirm Delete", callback_data: "confirm_delete" },
      { text: "Cancel", callback_data: "cancel_delete" }
    ]
  ]);
}

function dashboardKeyboard() {
  return actionKeyboard([
    [
      { text: "▶️ Run dev", callback_data: "cmd_dev" },
      { text: "🛑 Stop all", callback_data: "cmd_stop" }
    ],
    [
      { text: "🌳 Tree", callback_data: "cmd_tree" },
      { text: "🐙 Git status", callback_data: "cmd_git_status" }
    ],
    [
      { text: "🚀 Deploy", callback_data: "cmd_deploy" },
      { text: "🧹 Lint", callback_data: "cmd_lint" }
    ],
    [
      { text: "⚙️ Engine", callback_data: "cmd_engine" },
      { text: "📁 Workspace", callback_data: "cmd_workspace" }
    ],
    [
      { text: "◀️ Menu", callback_data: "cmd_main_menu" }
    ]
  ]);
}

async function handleDashboard(bot, msg) {
  const text = [
    `🎛 *DASHBOARD*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `_Pilih aksi cepat di bawah._`
  ].join("\n");
  await reply(bot, msg, text, { parse_mode: "Markdown", ...dashboardKeyboard() });
}

function rollbackKeyboard() {
  return actionKeyboard([
    [
      { text: "↩️ Rollback", callback_data: "rollback_last" },
      { text: "🔨 Verify", callback_data: "cmd_verify_build" }
    ],
    [
      { text: "◀️ Coding console", callback_data: "cmd_remote_coding" }
    ]
  ]);
}


function normalizeNatural(text) {
  return String(text || "").trim();
}

function isAffirmative(text) {
  return /^(ya|iya|yes|y|ok|oke|gas|lanjut|simpan|confirm|setuju|boleh|terapkan)$/i.test(normalizeNatural(text));
}

function isNegative(text) {
  return /^(batal|cancel|jangan|tidak|no|n|stop|batalkan)$/i.test(normalizeNatural(text));
}

function extractNaturalPath(text) {
  const value = normalizeNatural(text);
  const pathMatch = value.match(/([A-Za-z]:[\\/][^\n]+|(?:src|app|pages|components|lib|utils|styles|public)[\\/][^\s'"`()]+|[A-Za-z0-9_.-]+\.(?:jsx?|tsx?|json|css|scss|py|md))/i);
  return pathMatch?.[1]?.replace(/[),.;]+$/g, "") || "";
}

function extractAfter(text, patterns) {
  const value = normalizeNatural(text);
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function escapeMarkdown(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/[_*`\[]/g, (char) => `\\${char}`);
}

function cleanTerminalOutput(text) {
  if (!text) return "";
  // Strip ANSI escape codes
  let clean = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
  
  // Resolve carriage returns: only keep the last part of a line overwritten by \r
  const lines = clean.split(/\r?\n/).map((line) => {
    const parts = line.split('\r');
    return parts[parts.length - 1];
  });
  
  // Filter out npm progress bar lines or other useless spinner lines
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Filter out typical npm spinner/progress artifacts e.g. "⠋", "⠙", "⠹", etc.
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(trimmed) && trimmed.length < 5) return false;
    return true;
  });

  return filtered.join('\n') || clean;
}

function summarizeCommandResult(result) {
  const output = String(result.output || "");
  const fileRefs = output.match(/(?:src|app|pages|components|lib|utils|styles)[\\/][^\s'"`()]+?\.(?:jsx?|tsx?|json|css|scss|py|md)(?::\d+)?(?::\d+)?/gi) || [];
  const errorLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /error|failed|exception|cannot|not found|syntax/i.test(line));

  if (result.ok) return "✔ *OPERATIONAL SUCCESS:* Protocol executed without interruption.";

  const cleanRefs = [...new Set(fileRefs)].slice(0, 3).map(ref => ref.replace(/`/g, "'")).join(", ");
  const cleanErrorLine = errorLine ? truncateOutput(errorLine, 400).replace(/`/g, "'") : "";

  return [
    `🚨 *MUTATION PROTOCOL FAILURE* 🚨`,
    `══════════════════`,
    fileRefs.length ? `🔍 *Target Files:* \`${cleanRefs}\`` : null,
    errorLine ? `⚠️ *Root Cause:* \`${cleanErrorLine}\`` : "⚠️ *Root Cause:* No distinct error signature identified.",
    ``,
    `💡 _Type /fix or click repair to activate self-healing loop._`
  ]
    .filter(Boolean)
    .join("\n");
}

function isExpiredPending(pending) {
  return !pending || Date.now() - pending.createdAt > pendingTtlMs;
}

function sameProjectPath(left, right) {
  return Boolean(left && right && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase());
}

function clearRuntimePendingForProject(projectDir) {
  for (const [userId, pending] of pendingEdits.entries()) {
    if (isExpiredPending(pending) || !sameProjectPath(pending.projectDir, projectDir)) {
      pendingEdits.delete(userId);
    }
  }
  for (const [userId, pending] of pendingDeletes.entries()) {
    if (isExpiredPending(pending) || !sameProjectPath(pending.projectDir, projectDir)) {
      pendingDeletes.delete(userId);
    }
  }
}

async function syncActiveSession() {
  const projectDir = await ensureActiveProject();
  if (!projectDir) return null;
  await syncMemoryForProject(projectDir);
  clearRuntimePendingForProject(projectDir);
  return projectDir;
}

async function assertPendingDeleteFresh(pending) {
  if (!sameProjectPath(pending.projectDir, getActiveProjectDir())) {
    throw new Error("Pending delete berasal dari project lama. Jalankan delete ulang di project aktif.");
  }

  const info = await getProjectFileInfo(pending.projectDir, pending.filePath);
  if (pending.size !== undefined && pending.size !== info.size) {
    throw new Error("File sudah berubah sejak preview delete dibuat. Jalankan delete ulang agar data terbaru dipakai.");
  }
  if (pending.modifiedAt && pending.modifiedAt !== info.modifiedAt) {
    throw new Error("File sudah diupdate sejak preview delete dibuat. Jalankan delete ulang agar tidak menghapus data lama.");
  }
}

async function assertPendingEditFresh(pending) {
  if (!sameProjectPath(pending.projectDir, getActiveProjectDir())) {
    throw new Error("Pending edit berasal dari project lama. Jalankan edit ulang di project aktif.");
  }
  if (pending.type === "create") return;

  const info = await getProjectFileInfo(pending.projectDir, pending.filePath);
  if (pending.baseSize !== undefined && pending.baseSize !== info.size) {
    throw new Error("File sudah berubah sejak preview edit dibuat. Jalankan edit ulang agar data terbaru dipakai.");
  }
  if (pending.baseModifiedAt && pending.baseModifiedAt !== info.modifiedAt) {
    throw new Error("File sudah diupdate sejak preview edit dibuat. Jalankan edit ulang agar tidak menimpa data lama.");
  }
}

async function requireAdmin(bot, msg) {
  const userId = msg.from?.id;
  if (!isAdminUser(userId)) {
    await logger.warn("Unauthorized Telegram access blocked", {
      userId,
      username: msg.from?.username,
      chatId: msg.chat?.id,
      text: msg.text ? String(msg.text).slice(0, 80) : ""
    });
    // Polite reject sekali per chat (silent fail kalau gagal kirim).
    if (msg.chat?.type === "private") {
      await bot.sendMessage(
        msg.chat.id,
        "🚫 Bot ini privat. Hanya owner yang boleh akses.\n_Kalau kamu owner, set `OWNER_TELEGRAM_ID` (atau `TELEGRAM_USER_ID`) di `.env`._",
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
    return false;
  }

  if (msg.chat?.type !== "private") {
    await bot.sendMessage(msg.chat.id, "Demi keamanan, gunakan bot ini lewat private chat.").catch(() => {});
    return false;
  }

  return true;
}

function helpText() {
  const engine = `${config.aiProvider.toUpperCase()} · ${config.aiModel}`;
  return [
    `⚡ *CORE MISSION PROTOCOLS* ⚡`,
    `══════════════════`,
    `_Agent interface supports Voice, Image, & Text._`,
    ``,
    `❯ *CODING INTERFACE*`,
    `• "Build landing page glassmorphism"`,
    `• "Fix this bug" _(reply error message)_`,
    `• "Explain this code block"`,
    ``,
    `❯ *PROJECT DATABASE*`,
    `• "Switch to project portfolio"`,
    `• "List all files in src"`,
    `• "Send index.js to me"`,
    ``,
    `❯ *SYSTEM COMMANDS*`,
    `• "Status hardware RAM & CPU"`,
    `• "Kill process on port 3000"`,
    `• "Lock console" / "Shutdown host"`,
    ``,
    `══════════════════`,
    `❖ /dashboard — Command Center`,
    `❖ /projects — Repository List`,
    `❖ /engine — AI Logic Core`,
    `══════════════════`,
    `[ *STATUS:* READY ] [ *BUILD:* v2.5 ]`,
    `[ *ENGINE:* ${engine} ]`
  ].join("\n");
}

async function handleEngine(bot, msg) {
  const [kiroCliStatus, providersMod] = await Promise.all([
    checkKiroCli().catch(() => ({ ok: false, version: "", error: "check failed" })),
    import("../ai/providers.js")
  ]);
  const { providers: allProviders, listConfiguredProviders } = providersMod;

  const runtimeStatus = {
    "gemini-apikey": (() => {
      const hasKey = !!String(config.geminiApiKey || "").trim();
      return hasKey
        ? { ok: true, version: "api key ready" }
        : { ok: false, error: "GEMINI_API_KEY belum diisi" };
    })(),
    "kiro-apikey": (() => {
      const hasKey = !!String(config.kiroApiKey || "").trim();
      if (!hasKey) return { ok: false, error: "KIRO_API_KEY belum diisi" };
      if (!kiroCliStatus.ok) return { ok: false, error: kiroCliStatus.error || "kiro-cli tidak siap" };
      return { ok: true, version: kiroCliStatus.version || "kiro-cli ready" };
    })()
  };

  // Single neutral glyph per provider - no rainbow emoji.
  const providerGlyph = {
    "gemini-apikey": "G",
    "kiro-apikey": "K"
  };

  const rows = [];
  for (const [pid, provider] of Object.entries(allProviders)) {
    const rt = runtimeStatus[pid];
    const configured = provider.isConfigured(config);
    const ready = rt ? rt.ok : configured;
    if (!configured && !rt) continue;
    const glyph = providerGlyph[pid] || "�";
    const isActive = config.aiProvider === pid;
    const statusTag = !ready ? "  [not ready]" : (isActive ? "  [active]" : "");
    const headerText = `- ${glyph}  ${provider.label}${statusTag}  -`;
    rows.push([{ text: headerText, callback_data: "noop" }]);
    if (!ready) continue;
    const models = provider.models || [];
    for (let i = 0; i < models.length; i += 2) {
      rows.push(
        models.slice(i, i + 2).map((model) => {
          const isActiveModel = isActive && config.aiModel === model;
          const prefix = isActiveModel ? "* " : `${glyph} `;
          const shortId = registerEngineModel(pid, model);
          return {
            text: `${prefix}${model.length > 26 ? model.slice(0, 23) + "�" : model}`,
            callback_data: `engine_pick_${shortId}`
          };
        })
      );
    }
    rows.push([{ text: `${glyph}  Custom model...`, callback_data: `engine_custom_${pid}` }]);
  }

  rows.push([{ text: "Menu", callback_data: "cmd_main_menu" }]);

  const statusLines = [];
  for (const [id, rt] of Object.entries(runtimeStatus)) {
    const provider = allProviders[id];
    const g = providerGlyph[id] || "�";
    statusLines.push(rt.ok
      ? `${T.ok}  ${g} ${provider.label}  ${rt.version || "ok"}`
      : `${T.fail}  ${g} ${provider.label}  ${truncMid(rt.error || "not detected", 50)}`);
  }
  for (const provider of listConfiguredProviders(config)) {
    if (runtimeStatus[provider.id]) continue;
    const g = providerGlyph[provider.id] || "�";
    statusLines.push(`${T.ok}  ${g} ${provider.label}  configured`);
  }
  // Show non-configured providers as muted
  for (const [pid, provider] of Object.entries(allProviders)) {
    if (runtimeStatus[pid]) continue;
    if (provider.isConfigured(config)) continue;
    const g = providerGlyph[pid] || "�";
    statusLines.push(`${T.pending}  ${g} ${provider.label}  no key`);
  }

  const text = [
    header("Engine", `active: ${config.aiProvider}/${config.aiModel}`, { icon: "AI" }),
    "",
    "*Status*",
    statusLines.join("\n"),
    "",
    "_Pilih provider & model di bawah._"
  ].join("\n");

  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows }
  });
}

async function handleStart(bot, msg) {
  await ensureActiveProject();
  const workspace = getWorkspaceDir();
  const project = getActiveProjectPath();
  const projectName = project ? path.basename(project) : "NONE";
  const engine = `${config.aiProvider.toUpperCase()} · ${config.aiModel}`;
  const name = msg.from?.first_name || "Agent";

  const banner = [
    `⚡ *ASSISTANT CODING* ⚡`,
    `══════════════════`,
    `❯ Welcome back, *Agent ${name}*.`,
    `❯ Security clearance: \`LEVEL 4\``,
    `❯ System status: \`ONLINE\``,
    ``,
    `❖ *CORE METADATA*`,
    `\`ID      :: ${msg.from.id}\``,
    `\`TARGET  :: ${projectName}\``,
    `\`ENGINE  :: ${engine}\``,
    ``,
    `_Listening for mission instructions..._`,
    `_Type /help for protocol documentation._`
  ].join("\n");
  await bot.sendMessage(msg.chat.id, banner, { parse_mode: "Markdown" });
}

function helpTextV2() {
  const engine = `${config.aiProvider}/${config.aiModel}`;
  const projectName = getActiveProjectName();

  return [
    header("Help", `${config.agentName || "O-W-O"} Familiar`, { icon: T.info }),
    `${T.project} \`${projectName}\`  ${T.brain} \`${engine}\``,
    "",
    "*Agent*",
    bullets([
      "`/agent <task>` - eksplor, edit, verify project",
      "`/ask <question>` - tanya project/umum",
      "`/cancel` - batalkan agent berjalan",
      "`/retry` - ulangi prompt terakhir"
    ]),
    "",
    "*Files & code*",
    bullets([
      "`/files` - lihat struktur",
      "`/read <path>` - baca file aman",
      "`/write <path> <content>` - preview write exact content",
      "`/edit <path> <instruction>` - preview edit AI",
      "`/backup <path>` - backup file"
    ]),
    "",
    "*Runtime*",
    bullets([
      "`/run <command>` - safe command executor",
      "`/status` - status project",
      "`/logs` - command logs",
      "`/sync` - refresh state"
    ]),
    "",
    "*Approval*",
    bullets([
      "`/approvals` - daftar ticket",
      "`/approve <id>` - setujui",
      "`/reject <id>` - tolak"
    ]),
    "",
    "*Memory & skills*",
    bullets([
      "`/memory` - summary",
      "`/memory add <text>` - simpan preferensi",
      "`/memory forget <keyword>` - hapus memory",
      "`/skills` - daftar skills",
      "`/skills show <name>`",
      "`/skills delete <name>`",
      "`/skill save <name>`"
    ]),
    "",
    "*Connectors*",
    bullets([
      "`/connector`",
      "`/connector status <github|discord|x>`",
      "`/connector test <github|discord|x>`",
      "`/connector refresh <github|discord|x>`",
      "`/login github`"
    ]),
    "",
    "*Other*",
    bullets([
      "`/whoami` - Telegram user/chat id",
      "`/engine` - provider/model",
      "`/projects` `/workspace` - project scope",
      "`/laptop` - optional laptop remote controls"
    ]),
    "",
    "_Natural language bisa dipakai, tapi action risky tetap masuk approval._"
  ].join("\n");

  return [
    header("Help", "O-W-O Remote", { icon: T.info }),
    `${T.project} \`${projectName}\`  ·  ${T.brain} \`${engine}\``,
    "",
    "*Agent (autonomous)*",
    bullets([
      "`/agent <task>` — eksplor, edit, verify project",
      "`/cancel` — batalkan agent berjalan",
      "`/retry` — ulangi prompt terakhir",
      "`/initagent` — bikin AGENT.md (rules custom)"
    ]),
    "",
    "*Chat & AI*",
    bullets([
      "`/chat` — toggle casual chat mode",
      "`/persona <gaya>` — set karakter AI",
      "`/quick <q>` (alias `/q`) — tanya cepat",
      "`/engine` — ganti provider / model"
    ]),
    "",
    "*File & Code*",
    bullets([
      "`/edit path instruksi` — preview edit AI",
      "`/fix path error` — auto fix",
      "`/create path instruksi` — file baru",
      "`/read path` · `/delete path` · `/rollback path`",
      "`/search keyword` · `/zip` · `/snippet`"
    ]),
    "",
    "*Project*",
    bullets([
      "`/projects` `/select` — pilih project",
      "`/workspace` `/setworkspace path`",
      "`/tree` `/findproject keyword`"
    ]),
    "",
    "*Dev ops*",
    bullets([
      "`/dev` `/build` `/lint` `/test` — npm shortcut",
      "`/run cmd` · `/stop [all]` · `/restart`",
      "`/logs` `/livelogs` · `/tunnel 3000` · `/deploy`",
      "`/format` · `/push`"
    ]),
    "",
    "*Laptop remote*",
    bullets([
      "`/laptop` `/apps` · `/screenshot`",
      "`/open app` · `/close app` · `/url <link>`",
      "`/lock` `/shutdown` `/restart` · `/kill 3000`"
    ]),
    "",
    "*Status & misc*",
    bullets([
      "`/diagnose` — health check provider",
      "`/history` — task per project",
      "`/briefing` — daily summary",
      "`/sysinfo` `/health` · `/sync` · `/clear`"
    ]),
    "",
    `_Tip: ketik natural ('agent: tambah dark mode', 'fix ini', 'baca src/App.jsx'), kirim voice/screenshot, atau pakai_ \`$cmd\` _untuk shell cepat._`
  ].join("\n");
}

function getMainMenuKeyboard(processCount = 0) {
  const rows = [
    [
      { text: "🖥️ Laptop", callback_data: "cmd_remote_laptop" },
      { text: "⌨️ Coding", callback_data: "cmd_remote_coding" }
    ],
    [
      { text: "🤖 Agent", callback_data: "cmd_agent_help" },
      { text: "📊 Dashboard", callback_data: "cmd_dashboard_visual" }
    ],
    [
      { text: "⚙️ Engine", callback_data: "cmd_engine" },
      { text: "📖 Help", callback_data: "cmd_help" }
    ]
  ];

  if (processCount > 0) {
    rows.push([
      { text: `🛑 Stop all (${processCount})`, callback_data: "cmd_stop_all" }
    ]);
  }

  rows.push([{ text: "🔄 Refresh", callback_data: "cmd_main_menu" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function handleStartV2(bot, msg) {
  await ensureActiveProject();
  const project = getActiveProjectPath();
  const projectName = project ? path.basename(project) : "—";
  const engine = `${config.aiProvider.toUpperCase()} · ${config.aiModel}`;
  const name = msg.from?.first_name || "User";
  const running = listRunningProcesses();
  const processCount = running.length;
  const now = new Date();
  const hour = now.getHours();
  const timeStr = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  const dateStr = now.toLocaleDateString("id-ID", { weekday: "long", day: "2-digit", month: "short", year: "numeric" });
  const greeting = hour < 12 ? "Selamat Pagi" : hour < 17 ? "Selamat Siang" : hour < 21 ? "Selamat Sore" : "Selamat Malam";
  const uptimeHrs = (os.uptime() / 3600).toFixed(1);
  const ramFree = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
  const ramTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(0);
  const serverState = processCount > 0 ? `${processCount} running` : "idle";

  const text = [
    `*${config.agentName || "O-W-O"} Familiar*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `${greeting}, *${name}*`,
    `📆 _${dateStr}_  ·  ⏱ _${timeStr}_`,
    ``,
    `┌─ 💻 *SYSTEM STATUS*`,
    `├─ 📂 *Active*    \`${projectName}\``,
    `├─ 🧠 *Engine*    \`${engine}\``,
    `├─ 🔌 *Server*    ${serverState}`,
    `└─ 🔋 *Memory*    \`${ramFree} / ${ramTotal} GB free\``,
    ``,
    `┌─ ⚙️ *LAPTOP CORE*`,
    `├─ 🖥️ *Platform*  \`${os.type()}\``,
    `└─ ⏱  *Uptime*    \`${uptimeHrs} hours\``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `💡 _Tip: ketik perintah, kirim voice note, atau screenshot._`
  ].join("\n");

  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: "Markdown",
    ...getMainMenuKeyboard(processCount)
  });
}

// ═══════════════════════════════════════
// 1️⃣  LAPTOP CONTROL — System & Apps
// ═══════════════════════════════════════
function remoteLaptopKeyboard() {
  return actionKeyboard([
    [
      { text: "🚀 Apps", callback_data: "desktop_open_apps" },
      { text: "📊 Active", callback_data: "desktop_active_apps" },
      { text: "📸 Capture", callback_data: "desktop_screenshot" }
    ],
    [
      { text: "🔒 Lock", callback_data: "cmd_pc_lock" },
      { text: "⚡ Power", callback_data: "cmd_pc_power_menu" },
      { text: "❌ Close app", callback_data: "desktop_close_apps" }
    ],
    [
      { text: "🌐 Browser & media", callback_data: "cmd_browser_menu" },
      { text: "🖱️ Mouse", callback_data: "cmd_mouse_panel" }
    ],
    [
      { text: "◀️ Menu", callback_data: "cmd_main_menu" }
    ]
  ]);
}

// ═══════════════════════════════════════
// 1.5️⃣ MOUSE CONTROL — Remote Mouse
// ═══════════════════════════════════════
function mouseControlKeyboard() {
  return actionKeyboard([
    [
      { text: "↖", callback_data: "cmd_mouse_ul" },
      { text: "↑", callback_data: "cmd_mouse_u" },
      { text: "↗", callback_data: "cmd_mouse_ur" }
    ],
    [
      { text: "←", callback_data: "cmd_mouse_l" },
      { text: "● Click", callback_data: "cmd_mouse_click" },
      { text: "→", callback_data: "cmd_mouse_r" }
    ],
    [
      { text: "↙", callback_data: "cmd_mouse_dl" },
      { text: "↓", callback_data: "cmd_mouse_d" },
      { text: "↘", callback_data: "cmd_mouse_dr" }
    ],
    [
      { text: "⇡ Scroll up", callback_data: "cmd_scroll_up" },
      { text: "⇣ Scroll down", callback_data: "cmd_scroll_down" }
    ],
    [
      { text: "← Laptop", callback_data: "cmd_remote_laptop" }
    ]
  ]);
}

// ═══════════════════════════════════════
// 2️⃣  MEDIA & BROWSER — All-in-one remote
// ═══════════════════════════════════════
function mediaControlKeyboard() {
  return actionKeyboard([
    [
      { text: "⌕ Google", callback_data: "browser_mode_google" },
      { text: "♪ Spotify", callback_data: "browser_mode_spotify" },
      { text: "▷ YouTube", callback_data: "browser_mode_youtube" }
    ],
    [
      { text: "↗ Open URL", callback_data: "browser_mode_url" },
      { text: "▤ Shorts", callback_data: "browser_open_shorts" }
    ],
    [
      { text: "♬ TikTok", callback_data: "browser_open_tiktok" },
      { text: "◫ Reels", callback_data: "browser_open_reels" }
    ],
    [
      { text: "⏮", callback_data: "cmd_media_prev" },
      { text: "⏯", callback_data: "cmd_media_play" },
      { text: "⏭", callback_data: "cmd_media_next" }
    ],
    [
      { text: "⊘", callback_data: "cmd_media_mute" },
      { text: "− vol", callback_data: "cmd_media_voldown" },
      { text: "+ vol", callback_data: "cmd_media_volup" }
    ],
    [
      { text: "↑", callback_data: "cmd_scroll_up" },
      { text: "⏸ Pause", callback_data: "cmd_feed_pause" },
      { text: "↓", callback_data: "cmd_scroll_down" }
    ],
    [
      { text: "⊟ Min", callback_data: "cmd_pc_minimize" },
      { text: "⊡ Restore", callback_data: "cmd_pc_restore" },
      { text: "▢ Max", callback_data: "cmd_pc_maximize" },
      { text: "✕", callback_data: "cmd_browser_close_tab" }
    ],
    [
      { text: "← Laptop", callback_data: "cmd_remote_laptop" }
    ]
  ]);
}

/**
 * Moves the mouse relatively using PowerShell Forms Cursor Position.
 */
async function handleMouseMove(bot, queryId, dx, dy) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
$p.X += ${dx}
$p.Y += ${dy}
[System.Windows.Forms.Cursor]::Position = $p
`;
  await runPowerShell(script);
  await bot.answerCallbackQuery(queryId).catch(() => {});
}
/**
 * Opens a search URL in browser, waits for load, then auto-clicks the first
 * playable result using PowerShell mouse automation.
 */
async function playSearchInBrowser(site, query) {
  let searchUrl = "";
  let siteLabel = "";
  // Spotify: green ▶ play button on Top Result card — upper area, center-right
  // YouTube: first video thumbnail — upper-left area
  let clickXPct = 0.5;
  let clickYPct = 0.5;

  switch (site) {
    case "spotify":
      searchUrl = `https://open.spotify.com/search/${encodeURIComponent(query)}`;
      siteLabel = "Spotify Web 🎵";
      clickXPct = 0.724;   // Center of the large green circular PLAY button (72.4% of width)
      clickYPct = 0.222;   // Center of the large green circular PLAY button (22.2% of height)
      break;
    case "youtube":
      searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      siteLabel = "YouTube 🎥";
      clickXPct = 0.38;   // first video thumbnail center
      clickYPct = 0.38;   // below search bar, first result row
      break;
  }

  const encodedUrl = Buffer.from(searchUrl, "utf8").toString("base64");

  const script = `
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @"
  using System;
  using System.Runtime.InteropServices;
  public class WinApiSpotify {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
      [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
      [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  }
"@
} catch {}

$u = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUrl}'))
Start-Process $u
Start-Sleep -Seconds 5

$proc = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'chrome|msedge|brave|firefox|opera') } | Select-Object -First 1
if ($proc) {
    [WinApiSpotify]::ShowWindow($proc.MainWindowHandle, 3) # Maximize to guarantee Full Screen Max Size!
    [WinApiSpotify]::SwitchToThisWindow($proc.MainWindowHandle, $true)
    Start-Sleep -Milliseconds 600
    
    # Calculate exact screen coordinates on Maximized layout
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $w = $bounds.Width
    $ht = $bounds.Height
    $cy = [int]($ht * ${clickYPct})
    $cx = [int]($w * ${clickXPct})
    
    # Spotify dynamic layout sensor: detects if the right sidebar is open or closed by checking for green button color
    if ("${site}" -eq "spotify") {
        $xOpen = [int]($w * 0.6395)   # 1228px on a 1920x1080 screen (sidebar open)
        $xClosed = [int]($w * 0.7245)  # 1391px on a 1920x1080 screen (sidebar closed)
        
        $bmp = New-Object System.Drawing.Bitmap(1, 1)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $sz = New-Object System.Drawing.Size(1, 1)
        $g.CopyFromScreen($xOpen, $cy, 0, 0, $sz)
        $color = $bmp.GetPixel(0, 0)
        $g.Dispose()
        $bmp.Dispose()
        
        # Spotify Green check: G component is high, R & B components are lower
        if ($color.G -gt 150 -and $color.R -lt 100 -and $color.B -lt 150) {
            $cx = $xOpen
        } else {
            $cx = $xClosed
        }
    }
    
    $origPos = [System.Windows.Forms.Cursor]::Position
    [WinApiSpotify]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 200
    
    # Double Click Sequence to guarantee focus + play action
    [WinApiSpotify]::mouse_event(2, 0, 0, 0, 0) # Click 1 Down
    Start-Sleep -Milliseconds 40
    [WinApiSpotify]::mouse_event(4, 0, 0, 0, 0) # Click 1 Up
    Start-Sleep -Milliseconds 100
    [WinApiSpotify]::mouse_event(2, 0, 0, 0, 0) # Click 2 Down
    Start-Sleep -Milliseconds 40
    [WinApiSpotify]::mouse_event(4, 0, 0, 0, 0) # Click 2 Up
    
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.Cursor]::Position = $origPos
}
`;
  const result = await runPowerShell(script);
  return { ok: result.ok, output: result.output, siteLabel, searchUrl };
}

function remoteCodingKeyboard() {
  return actionKeyboard([
    [
      { text: "◉ Agent", callback_data: "cmd_agent_help" },
      { text: "⌘ Terminal", callback_data: "cmd_terminal" }
    ],
    [
      { text: "📁 Projects", callback_data: "cmd_projects" },
      { text: "▶ Dev", callback_data: "cmd_dev" },
      { text: "⎇ Git", callback_data: "cmd_git_menu" }
    ],
    [
      { text: "▣ Tools", callback_data: "cmd_project_tools" },
      { text: "⎓ Ports", callback_data: "cmd_port_tools" },
      { text: "⎙ Logs", callback_data: "cmd_log_center" }
    ],
    [
      { text: "⚙ Engine", callback_data: "cmd_engine" },
      { text: "✦ AI chat", callback_data: "cmd_ai_project_chat" },
      { text: "🗀 Workspace", callback_data: "cmd_workspace" }
    ],
    [
      { text: "↻ Refresh", callback_data: "cmd_remote_coding" },
      { text: "← Menu", callback_data: "cmd_main_menu" }
    ]
  ]);
}

function shortButtonText(value, maxLength = 38) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text || "(tanpa nama)";
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatDesktopApp(app, index) {
  const title = app.title ? ` - ${app.title}` : "";
  return `${index + 1}. ${app.name || "app"} [PID ${app.pid}]${title}`;
}

async function handleRemoteLaptop(bot, msg) {
  const result = await listActiveDesktopApps({ limit: 15 });
  const activeCount = result.ok ? result.apps.length : 0;
  const preview = result.ok && result.apps.length
    ? result.apps.slice(0, 5).map((app, index) => `${index + 1}. ${escapeMarkdown(app.name)} [${app.pid}]`).join("\n")
    : "Belum ada aplikasi berjendela yang terbaca.";
  const text = [
    `🖥 *LAPTOP CONTROL*`,
    `══════════════════`,
    `📊 Active Windows: \`${activeCount}\``,
    ``,
    activeCount > 0 ? `*Running:*\n${preview}` : `_Belum ada aplikasi berjendela._`,
    ``,
    `_Gunakan tombol di bawah untuk kontrol._`
  ].filter(Boolean).join("\n");

  await reply(bot, msg, text, { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
}

async function handleActiveDesktopApps(bot, msg) {
  const result = await listActiveDesktopApps({ limit: 20 });
  if (!result.ok) {
    await reply(bot, msg, `❌ *GAGAL MEMBACA APPS*\n══════════════════\n${result.output}`, { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
    return;
  }

  const rows = result.apps.map((app) => [
    {
      text: `💻 ${shortButtonText(app.title || app.name, 24)}`,
      callback_data: createDesktopAppCallback("switch", { pid: app.pid, name: app.name, title: app.title })
    },
    {
      text: "❌",
      callback_data: createDesktopAppCallback("close", { pid: app.pid, name: app.name, title: app.title })
    }
  ]);
  rows.push([{ text: "🔄 Refresh List", callback_data: "desktop_active_apps" }]);
  rows.push([{ text: "◀️ Laptop Control", callback_data: "cmd_remote_laptop" }]);

  const text = [
    `🔄 *ALT+TAB / WINDOW SWITCHER*`,
    `══════════════════`,
    `💻 Active Windows: \`${result.apps.length}\``,
    ``,
    result.apps.length
      ? result.apps.map(formatDesktopApp).join("\n")
      : "_Tidak ada aplikasi berjendela yang aktif._",
    ``,
    `_Klik nama aplikasi untuk beralih (Alt+Tab), atau tombol ❌ untuk menutup._`
  ].join("\n");

  await reply(bot, msg, text, { parse_mode: "Markdown", ...actionKeyboard(rows) });
}

async function handleLaunchableDesktopApps(bot, msg, { forceRefresh = false } = {}) {
  const result = await listLaunchableApps({ limit: 30, forceRefresh });
  if (!result.ok) {
    await reply(bot, msg, `❌ *GAGAL MEMBACA APPS*\n══════════════════\n${result.output}`, { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
    return;
  }

  const rows = result.apps.slice(0, 24).map((app) => [
    {
      text: `Buka ${shortButtonText(app.name)}`,
      callback_data: createDesktopAppCallback("open", { name: app.name, path: app.path })
    }
  ]);
  rows.push([{ text: "🔄 Refresh", callback_data: "desktop_refresh_apps" }]);
  rows.push([{ text: "◀️ Laptop Control", callback_data: "cmd_remote_laptop" }]);

  const text = [
    `🚀 *LAUNCH APPLICATION*`,
    `══════════════════`,
    `💾 Source: \`Start Menu & Desktop\``,
    ``,
    result.apps.length
      ? result.apps.slice(0, 24).map((app, index) => `${index + 1}. \`${app.name}\``).join("\n")
      : "_Tidak ada shortcut aplikasi yang ditemukan._",
    ``,
    `_Pilih tombol \`Buka\` di bawah untuk menjalankan aplikasi._`
  ].join("\n");

  await reply(bot, msg, text, { parse_mode: "Markdown", ...actionKeyboard(rows) });
}

async function handleCloseDesktopApp(bot, msg, token) {
  const selection = desktopAppSelections.get(token);
  if (!selection || selection.kind !== "close") {
    await reply(bot, msg, "⚠️ _Pilihan aplikasi sudah expired. Buka ulang menu Aplikasi Aktif._", { parse_mode: "Markdown" });
    return;
  }

  desktopAppSelections.delete(token);
  const app = selection.payload;
  await reply(
    bot,
    msg,
    [
      `⚠️ *CONFIRM CLOSE*`,
      `══════════════════`,
      `💻 App: \`${app.name || "(unknown)"}\``,
      `🆔 PID: \`${app.pid}\``,
      app.title ? `📝 Title: \`${app.title}\`` : null,
      ``,
      `_Tekan konfirmasi untuk menutup aplikasi ini._`
    ].filter(Boolean).join("\n"),
    actionKeyboard([
      [{ text: `Ya, tutup ${shortButtonText(app.name || app.title, 24)}`, callback_data: createDesktopAppCallback("confirmclose", app) }],
      [{ text: "Batal", callback_data: "desktop_cancel_close" }]
    ])
  );
}

async function handleConfirmCloseDesktopApp(bot, msg, token) {
  const selection = desktopAppSelections.get(token);
  if (!selection || selection.kind !== "confirmclose") {
    await reply(bot, msg, "⚠️ _Konfirmasi sudah expired. Buka ulang menu Aplikasi Aktif._", { parse_mode: "Markdown" });
    return;
  }

  desktopAppSelections.delete(token);
  const app = selection.payload;
  const result = await closeDesktopApp(app.pid);
  const detail = result.detail || {};
  await reply(
    bot,
    msg,
    result.ok
      ? [
          `✅ *APPLICATION CLOSED*`,
          `══════════════════`,
          `📊 Status: \`${detail.status || "closed"}\``,
          `💻 App: \`${detail.name || app.name}\``,
          `🆔 PID: \`${detail.pid || app.pid}\``
        ].join("\n")
      : [
          `❌ *CLOSE FAILED*`,
          `══════════════════`,
          `🎯 Target: \`${app.name || app.pid}\``,
          result.output
        ].join("\n"),
    { parse_mode: "Markdown", ...remoteLaptopKeyboard() }
  );
}

async function handleOpenDesktopApp(bot, msg, token) {
  const selection = desktopAppSelections.get(token);
  if (!selection || selection.kind !== "open") {
    await reply(bot, msg, "⚠️ _Pilihan aplikasi sudah expired. Buka ulang menu Buka Aplikasi._", { parse_mode: "Markdown" });
    return;
  }

  desktopAppSelections.delete(token);
  const app = selection.payload;
  const result = await openDesktopApp(app.path);

  if (!result.ok) {
    await reply(bot, msg, [
      `❌ *LAUNCH FAILED*`,
      `══════════════════`,
      `🎯 Target: \`${app.name}\``,
      result.output
    ].join("\n"), { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
    return;
  }

  const postRows = [];
  if (isBrowserApp(app.name)) {
    postRows.push([{ text: "🌐 Buka URL", callback_data: `browser_url_${encodeURIComponent(app.name).slice(0, 30)}` }]);
  }
  postRows.push([
    { text: "📸 Screenshot", callback_data: "desktop_screenshot" },
    { text: "📊 List Apps", callback_data: "desktop_active_apps" }
  ]);
  postRows.push([{ text: "◀️ Laptop Control", callback_data: "cmd_remote_laptop" }]);

  await reply(bot, msg, [
    `✅ *APP LAUNCHED*`,
    `══════════════════`,
    `💻 \`${app.name}\``,
    ``,
    isBrowserApp(app.name) ? `_Ketik URL langsung atau tekan tombol di bawah._` : `_Aplikasi berhasil dibuka._`
  ].join("\n"), { parse_mode: "Markdown", ...actionKeyboard(postRows) });
}

async function handleSwitchDesktopApp(bot, msg, token) {
  const selection = desktopAppSelections.get(token);
  if (!selection || selection.kind !== "switch") {
    await reply(bot, msg, "⚠️ _Pilihan aplikasi sudah expired. Buka ulang menu Aplikasi Aktif._", { parse_mode: "Markdown" });
    return;
  }

  desktopAppSelections.delete(token);
  const app = selection.payload;
  
  const result = await runPowerShell(`
    try {
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class FocusHelper {
          [DllImport("user32.dll")]
          public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
          [DllImport("user32.dll")]
          public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
      }
"@
    } catch {}
    
    $proc = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        [FocusHelper]::ShowWindow($proc.MainWindowHandle, 9)
        [FocusHelper]::SwitchToThisWindow($proc.MainWindowHandle, $true)
        Write-Output "OK"
    } else {
        $procByTitle = Get-Process | Where-Object { $_.MainWindowTitle -like "*${app.title}*" -or $_.ProcessName -eq "${app.name}" } | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($procByTitle) {
            [FocusHelper]::ShowWindow($procByTitle.MainWindowHandle, 9)
            [FocusHelper]::SwitchToThisWindow($procByTitle.MainWindowHandle, $true)
            Write-Output "OK"
        } else {
            Write-Output "NOT_FOUND"
        }
    }
  `);

  if (result.ok && result.output.trim() === "OK") {
    await reply(bot, msg, `✅ *ALT+TAB SUCCESS*\n══════════════════\n💻 Berhasil beralih ke: \`${app.name || app.title}\``, { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
  } else {
    await reply(bot, msg, `❌ *ALT+TAB FAILED*\n══════════════════\n⚠️ Jendela aktif untuk \`${app.name || app.title}\` tidak ditemukan.`, { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
  }
}

async function handleLaptopScreenshot(bot, msg) {
  await sendTyping(bot, msg.chat.id);
  const result = await captureDesktopScreenshot();
  if (!result.ok) {
    await reply(bot, msg, `❌ *SCREENSHOT FAILED*\n══════════════════\n${result.output}`, { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
    return;
  }

  await bot.sendPhoto(msg.chat.id, result.path, {
    caption: `📸 Screenshot • ${result.detail?.width || "?"}x${result.detail?.height || "?"} • Captured via Telegram Remote`
  });
  await fs.unlink(result.path).catch(() => {});
}

async function handleRemoteCodingMenu(bot, msg) {
  const project = getActiveProjectPath();
  const projectName = project ? path.basename(project) : "(belum ada)";
  const running = listRunningProcesses();
  const text = [
    `⌨️ *CODING CONSOLE*`,
    `══════════════════`,
    `📂 Project: \`${projectName}\``,
    `📍 Workspace: \`${getWorkspaceDir() || "(belum ada)"}\``,
    `${running.length ? "🟢" : "⚪"} Process: \`${running.length ? running.length + " active" : "idle"}\``,
    ``,
    `*Quick:* \`$ npm run dev\` \`$ git status\``,
    `*Shell:* \`/terminal\` lalu ketik command`,
    ``,
    `_Pilih aksi di bawah._`
  ].join("\n");

  await reply(bot, msg, text, { parse_mode: "Markdown", ...remoteCodingKeyboard() });
}


async function handleWhoami(bot, msg) {
  await reply(
    bot,
    msg,
    [
      `Telegram user id: ${msg.from?.id}`,
      `Username: ${msg.from?.username || "-"}`,
      `Chat id: ${msg.chat?.id}`,
      `Developer: ${isAdminUser(msg.from?.id) ? "ya" : "tidak"}`
    ].join("\n")
  );
}

async function handleHealth(bot, msg) {
  await sendTyping(bot, msg.chat.id);
  const antigravity = await detectAntigravity();
  const activeProject = getActiveProjectPath();
  const projectOk = activeProject ? "CONNECTED" : "OFFLINE";
  const workspaceOk = "READY";
  const missing = getMissingConfigKeys();

  await reply(
    bot,
    msg,
    [
      "⚡ *SYSTEM CORE DIAGNOSTICS* ⚡",
      `══════════════════`,
      `❯ *CONFIGURATION:* ${missing.length ? "INCOMPLETE" : "STABLE"}`,
      `❯ *WORKSPACE:*     ${workspaceOk}`,
      `❯ *PROJECT:*       ${projectOk}`,
      `❯ *AI_PROVIDER:*   ${config.aiProvider.toUpperCase()}`,
      `❯ *AI_MODEL:*      ${config.aiModel}`,
      `❯ *ANTIGRAVITY:*  ${antigravity.active ? "UPLINK_OK" : "NO_UPLINK"}`,
      ``,
      missing.length ? `⚠️ *WARNING:* Missing keys \`${missing.join(", ")}\`` : "🛡 *SECURITY:* All systems secure."
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleDiagnose(bot, msg) {
  await sendTyping(bot, msg.chat.id);
  const live = await liveProgress(bot, msg, [
    header("Diagnose", "checking providers...", { icon: "AI" }),
    `${T.pending}  _ping provider runtime..._`
  ].join("\n"));

  const providersMod = await import("../ai/providers.js");
  const kiroCli = await checkKiroCli({ timeoutMs: 4000 }).catch((e) => ({ ok: false, error: e.message }));

  const runtimeStatus = {
    "gemini-apikey": (() => {
      const hasKey = !!String(config.geminiApiKey || "").trim();
      return hasKey
        ? { ok: true, version: "api key ready" }
        : { ok: false, error: "GEMINI_API_KEY belum diisi" };
    })(),
    "kiro-apikey": (() => {
      const hasKey = !!String(config.kiroApiKey || "").trim();
      if (!hasKey) return { ok: false, error: "KIRO_API_KEY belum diisi" };
      if (!kiroCli.ok) return { ok: false, error: kiroCli.error || "kiro-cli tidak siap" };
      return { ok: true, version: kiroCli.version || "kiro-cli ready" };
    })()
  };

  const lines = [
    header("Diagnose", "system health", { icon: "AI" }),
    "",
    "*Runtime*",
    kv("node", process.version),
    kv("platform", `${process.platform}/${process.arch}`),
    kv("uptime", `${(process.uptime() / 60).toFixed(1)} min`),
    kv("heap", `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`),
    "",
    "*Active config*",
    kv("provider", config.aiProvider),
    kv("model", config.aiModel),
    kv("fallback", config.aiAutoFallback ? "on" : "off"),
    kv("workspace", getWorkspaceDir() || "(none)"),
    kv("project", getActiveProjectPath() ? path.basename(getActiveProjectPath()) : "(none)"),
    "",
    "*AI providers*"
  ];

  const providerGlyph = {
    "gemini-apikey": "G",
    "kiro-apikey": "K"
  };

  for (const [pid, provider] of Object.entries(providersMod.providers)) {
    const g = providerGlyph[pid] || "�";
    const hasRuntime = !!runtimeStatus[pid];
    if (hasRuntime) {
      const rt = runtimeStatus[pid];
      const sym = rt.ok ? T.ok : T.fail;
      lines.push(`${sym}  ${g} ${provider.label}  ${rt.ok ? `\`${rt.version || "ok"}\`` : `_${truncMid(rt.error || "unknown", 60)}_`}`);
    } else {
      const cfg = provider.isConfigured(config);
      const sym = cfg ? T.ok : T.pending;
      lines.push(`${sym}  ${g} ${provider.label}  ${cfg ? "_configured_" : "_no key_"}`);
    }
  }

  lines.push("", "*Integrations*");
  lines.push(process.env.NGROK_AUTHTOKEN ? `${T.ok}  Ngrok token set` : `${T.pending}  Ngrok token empty`);

  if (activeAgentSessions.size > 0) {
    lines.push("", `*Active agents* (${activeAgentSessions.size})`);
    for (const [, s] of activeAgentSessions) {
      const elapsed = ((Date.now() - s.startedAt) / 1000).toFixed(0);
      lines.push(`${T.bullet} \`${truncMid(s.label, 40)}\`  _${elapsed}s_`);
    }
  }

  const missing = getMissingConfigKeys();
  if (missing.length) {
    lines.push("", `${T.warn}  Missing keys: \`${missing.join(", ")}\``);
  }

  await live.finish(lines.join("\n"));
}

async function handleStatus(bot, msg) {
  await reply(
    bot,
    msg,
    [
      "Status",
      `Workspace: ${getWorkspaceDir()}`,
      `Project aktif: ${getActiveProjectPath() || "(belum ada)"}`,
      "",
      getProcessStatusText()
    ].join("\n")
  );
}

function isDriveRoot(folderPath) {
  const parsed = path.parse(path.resolve(folderPath));
  return path.resolve(folderPath).toLowerCase() === parsed.root.toLowerCase();
}

function formatFolderPath(folderPath) {
  return path.resolve(folderPath).replace(/\\/g, "/");
}

function looksLikeProjectFolder(folderPath) {
  const markers = [
    "package.json",
    "pnpm-workspace.yaml",
    "vite.config.js",
    "next.config.js",
    "pubspec.yaml",
    "composer.json",
    "requirements.txt",
    "pyproject.toml",
    "Cargo.toml",
    ".git"
  ];
  return markers.some((marker) => fsSync.existsSync(path.join(folderPath, marker)));
}

function folderTypeLabel(folderPath) {
  return looksLikeProjectFolder(folderPath) ? "Project folder" : "Regular folder";
}

async function listChildFolders(folderPath, { limit = 40 } = {}) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith(".") && !entry.name.startsWith("$"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

function folderBrowserKeyboard({ folderPath, folders = [], drives = [] }) {
  const rows = [];
  const resolved = path.resolve(folderPath);
  const parent = path.dirname(resolved);

  if (drives.length) {
    rows.push(
      drives.map((drive) => {
        const letter = drive.slice(0, 1).toUpperCase();
        return { text: `Home ${letter}:/`, callback_data: createFolderCallback("workspace", drive) };
      })
    );
  }

  if (!isDriveRoot(resolved) && parent && parent !== resolved) {
    rows.push([{ text: "⬆️ Naik 1 Folder", callback_data: createFolderCallback("browse", parent) }]);
  }

  if (!isDriveRoot(resolved)) {
    rows.push([
      { text: "✅ Pilih Sbg Project", callback_data: createFolderCallback("activate", resolved) },
      { text: "🖥 Buka Terminal", callback_data: createFolderCallback("terminal", resolved) }
    ]);
    rows.push([
      { text: "🔧 Jadikan Workspace", callback_data: createFolderCallback("workspace", resolved) },
      { text: "⚡ Open in IDE", callback_data: createFolderCallback("antigravity", resolved) }
    ]);
  }

  if (folders.length) {
    rows.push([{ text: "── Subfolder ──", callback_data: "noop" }]);
    rows.push(...folderRows(folders, resolved).slice(0, 35));
  }

  rows.push([{ text: "◀️ Menu", callback_data: "cmd_main_menu" }]);
  return actionKeyboard(rows);
}

async function handleBrowseFolder(bot, msg, folderPath) {
  const resolved = path.resolve(folderPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Folder tidak ditemukan: ${resolved}`);

  const drives = await listAvailableDrives();
  const folders = await listChildFolders(resolved);
  const currentProject = getActiveProjectPath();
  const activeLabel = currentProject ? path.basename(currentProject) : "(belum ada)";
  const folderList = folders.length
    ? folders.map((name, index) => {
        const childPath = path.join(resolved, name);
        const marker = looksLikeProjectFolder(childPath) ? " [project]" : "";
        return `${index + 1}. \`${name}\`${marker}`;
      }).join("\n")
    : "_Tidak ada subfolder di lokasi ini._";

  await reply(
    bot,
    msg,
    [
      `📂 *FOLDER BROWSER*`,
      `══════════════════`,
      `📍 \`${formatFolderPath(resolved)}\``,
      `🎯 Active: \`${activeLabel}\``,
      ``,
      folderList,
      ``,
      `_Klik folder untuk masuk. Gunakan tombol untuk aktifkan project._`
    ].join("\n"),
    {
      parse_mode: "Markdown",
      ...folderBrowserKeyboard({ folderPath: resolved, folders, drives })
    }
  );
}

async function activateFolderAsProject(bot, msg, folderPath) {
  const resolved = path.resolve(folderPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Folder tidak ditemukan: ${resolved}`);

  const workspacePath = path.dirname(resolved);
  const projectName = path.basename(resolved);
  await switchWorkspace(workspacePath);
  const activeDir = await switchProject(projectName);
  clearRuntimePendingForProject(activeDir);
  await syncMemoryForProject(activeDir);
  await rememberRecentProject(activeDir);
  printTerminalBanner();

  await reply(
    bot,
    msg,
    [
      "*PROJECT DIAKTIFKAN*",
      "",
      `Workspace: \`${workspacePath}\``,
      `Project: \`${projectName}\``,
      "",
      "_Project sudah aktif untuk command Telegram. IDE tidak dibuka otomatis._"
    ].join("\n"),
    { parse_mode: "Markdown", ...remoteCodingKeyboard() }
  );
}

async function openFolderInAntigravityExplicit(bot, msg, folderPath) {
  const resolved = path.resolve(folderPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Folder tidak ditemukan: ${resolved}`);

  if (await isSafeModeEnabled()) {
    await reply(
      bot,
      msg,
      [
        "CONFIRM OPEN IDE",
        "",
        `Folder: ${formatFolderPath(resolved)}`,
        "",
        "Safe Mode aktif. Konfirmasi dulu sebelum membuka aplikasi desktop."
      ].join("\n"),
      actionKeyboard([
        [{ text: "Ya, buka IDE", callback_data: createSafeActionCallback("open_antigravity", { path: resolved }) }],
        [{ text: "Batal", callback_data: "safe_cancel" }]
      ])
    );
    return;
  }

  await openProjectInAntigravity(resolved);
  await reply(
    bot,
    msg,
    [
      "*IDE OPENED*",
      "",
      `Folder: \`${formatFolderPath(resolved)}\``,
      "",
      "_Folder berhasil dibuka di IDE._"
    ].join("\n"),
    { parse_mode: "Markdown", ...folderBrowserKeyboard({ folderPath: resolved, folders: await listChildFolders(resolved), drives: await listAvailableDrives() }) }
  );
}

async function executeOpenAntigravity(bot, msg, folderPath) {
  const resolved = path.resolve(folderPath);
  await openProjectInAntigravity(resolved);
  await reply(
    bot,
    msg,
    [
      `✅ *IDE OPENED*`,
      `══════════════════`,
      `📂 Folder: \`${formatFolderPath(resolved)}\``
    ].join("\n"),
    { parse_mode: "Markdown", ...remoteCodingKeyboard() }
  );
}

async function handleWorkspace(bot, msg) {
  if (!getWorkspaceDir()) await ensureActiveProject();
  const currentWorkspace = getWorkspaceDir();
  await handleBrowseFolder(bot, msg, currentWorkspace);
}

async function handleSetWorkspace(bot, msg, args) {
  try {
    const workspacePath = parseSingleArgument(args, "Format: /setworkspace C:\\PROJECT atau /setworkspace D:\\PROJECT");
    await handleSetWorkspacePath(bot, msg, workspacePath);
    return;

  } catch (error) {
    await reply(bot, msg, `❌ *Gagal Ganti Workspace*\n══════════════════\n${error.message}`, { parse_mode: "Markdown" });
  }
}

async function handleSetWorkspacePath(bot, msg, workspacePath) {
  const result = await switchWorkspace(workspacePath);
  clearRuntimePendingForProject("");
  printTerminalBanner();

  await reply(
    bot,
    msg,
    [
      "*WORKSPACE DIPILIH*",
      "",
      `Workspace: \`${result.workspaceDir}\``,
      `Folder ditemukan: \`${result.projects.length}\``,
      "",
      "_Pilih folder dari tombol Telegram. IDE tidak dibuka otomatis._"
    ].join("\n"),
    { parse_mode: "Markdown" }
  );

  await handleBrowseFolder(bot, msg, result.workspaceDir);
}

async function handleDrives(bot, msg) {
  const drives = await listAvailableDrives();
  const projects = await listProjects().catch(() => []);
  const currentWorkspace = getWorkspaceDir();
  const currentProject = getActiveProjectName();
  await reply(
    bot,
    msg,
    [
      `Drive workspace tersedia: ${drives.length ? drives.join(", ") : "(tidak ada)"}`,
      "",
      "Contoh:",
      "/setworkspace C:\\PROJECT",
      "/setworkspace D:\\PROJECT",
      "/setworkspace C:\\",
      "/setworkspace D:\\"
    ].join("\n"),
    {
      ...workspaceKeyboard({
        drives,
        projects,
        currentWorkspace,
        currentProjectName: currentProject
      })
    }
  );
}

async function handleProjects(bot, msg) {
  if (!getWorkspaceDir()) await ensureActiveProject();
  const currentWorkspace = getWorkspaceDir();
  await handleBrowseFolder(bot, msg, currentWorkspace);
}

async function handleSwitch(bot, msg, args) {
  try {
    const projectName = String(args || "").trim();
    if (!projectName) throw new Error("Nama project wajib diisi. Contoh: /switch my-project");

    await sendTyping(bot, msg.chat.id);
    const activeDir = await switchProject(projectName);
    clearRuntimePendingForProject(activeDir);
    await syncMemoryForProject(activeDir);
    await rememberRecentProject(activeDir);
    
    // UI Update
    printTerminalBanner();
    
    const engine = `${config.aiProvider.toUpperCase()} · ${config.aiModel}`;
    
    await reply(
      bot, 
      msg, 
      [
        `✨ *PROJECT SWITCHED*`,
        `✦ _Target Locked & Loaded_`,
        ``,
        `  › Target: \`${projectName}\``,
        `  › Engine: \`${engine}\``,
        `  › Status: \`READY\``,
        ``,
        `_Sistem AI telah disinkronkan ke project baru. IDE tidak dibuka otomatis._`
      ].join("\n"), 
      { parse_mode: "Markdown", reply_markup: dashboardKeyboard() }
    );
  } catch (error) {
    await logger.error("Gagal ganti project", { error: error.message, args });
    const projects = await listProjects().catch(() => []);
    const hint = projects.length ? `\n\n*Project yang tersedia:*\n${projects.map(p => `• \`${p}\``).join("\n")}` : "";
    await reply(bot, msg, `❌ *Gagal Ganti Project*\n══════════════════\n${error.message}${hint}`, { parse_mode: "Markdown" });
  }
}

async function handleSelectProject(bot, msg) {
  const currentWorkspace = getWorkspaceDir();
  if (!currentWorkspace) {
    await reply(bot, msg, "❌ Workspace belum diatur. Gunakan `/setworkspace` terlebih dahulu.", { parse_mode: "Markdown" });
    return;
  }

  const projects = await listProjects().catch(() => []);
  if (!projects.length) {
    await reply(bot, msg, "❌ Tidak ada project di dalam workspace aktif.", { parse_mode: "Markdown" });
    return;
  }

  await reply(
    bot,
    msg,
    [
      `📂 *PILIH PROJECT*`,
      `══════════════════`,
      `_Klik salah satu tombol di bawah untuk mengaktifkan project._`
    ].join("\n"),
    { parse_mode: "Markdown", ...projectListKeyboard(projects, "cmd_main_menu") }
  );
}

async function handleOpenApp(bot, msg, args) {
  if (!args) {
    await reply(bot, msg, "❌ Format: `/open nama_aplikasi`", { parse_mode: "Markdown" });
    return;
  }
  
  const appQuery = args.trim().toLowerCase();
  await reply(bot, msg, `🔍 _Mencari aplikasi_ \`${appQuery}\`_..._`, { parse_mode: "Markdown" });
  
  const result = await listLaunchableApps({ limit: 10, query: appQuery });
  if (result.ok) {
    if (result.apps.length > 0) {
      // Cari yang paling mendekati (sama persis jika ada)
      const match = result.apps.find(app => 
        app.name.toLowerCase() === appQuery || 
        app.name.toLowerCase().includes(appQuery)
      ) || result.apps[0];
      
      if (match) {
        await reply(bot, msg, `🚀 _Membuka_ \`${match.name}\`_..._`, { parse_mode: "Markdown" });
        const openResult = await openDesktopApp(match.path);
        
        if (openResult.ok) {
          const postRows = [
            [{ text: "📸 Screenshot", callback_data: "desktop_screenshot" }],
            [{ text: "◀️ Menu Laptop", callback_data: "cmd_remote_laptop" }]
          ];
          await reply(bot, msg, `✅ *APP LAUNCHED*\n══════════════════\n💻 \`${match.name}\``, { parse_mode: "Markdown", ...actionKeyboard(postRows) });
        } else {
          await reply(bot, msg, `❌ *Gagal membuka* \`${match.name}\`\n${openResult.output}`, { parse_mode: "Markdown" });
        }
        return;
      }
    }
    
    // Saran jika tidak ketemu persis
    const allAppsResult = await listLaunchableApps({ limit: 100 });
    const suggestions = allAppsResult.ok ? allAppsResult.apps
      .filter(app => app.name.toLowerCase().includes(appQuery.slice(0, 3)))
      .slice(0, 5) : [];
      
    if (suggestions.length) {
      const rows = suggestions.map(app => [{
        text: `🚀 ${app.name}`,
        callback_data: createDesktopAppCallback("open", { name: app.name, path: app.path })
      }]);
      await reply(bot, msg, `🔍 *APP SEARCH*\n══════════════════\n_Tidak ditemukan persis. Mungkin maksud kamu:_`, { parse_mode: "Markdown", ...actionKeyboard(rows) });
    } else {
      await reply(bot, msg, `❌ *Aplikasi tidak ditemukan*\nTidak ada aplikasi yang cocok dengan \`${args}\`. Coba cek daftar dengan \`/apps\`.`, { parse_mode: "Markdown" });
    }
  } else {
    await reply(bot, msg, `❌ *Gagal mencari aplikasi*\nSistem tidak dapat membaca daftar aplikasi.\n\nError:\n${result.output}`, { parse_mode: "Markdown" });
  }
}

async function handleCloseApp(bot, msg, args) {
  if (!args) {
    await reply(bot, msg, "❌ Format: `/close nama_aplikasi`", { parse_mode: "Markdown" });
    return;
  }
  
  const appQuery = args.trim().toLowerCase();
  await reply(bot, msg, `🔍 _Mencari aplikasi_ \`${appQuery}\` _yang berjalan..._`, { parse_mode: "Markdown" });
  
  const result = await listActiveDesktopApps({ limit: 50 });
  if (result.ok) {
    if (result.apps.length > 0) {
      const match = result.apps.find(app => 
        app.name.toLowerCase().includes(appQuery) || 
        (app.title && app.title.toLowerCase().includes(appQuery))
      );
      
      if (match) {
        await reply(bot, msg, `🛑 _Menutup_ \`${match.name}\`_..._`, { parse_mode: "Markdown" });
        const closeResult = await closeDesktopApp(match.pid);
        if (closeResult.ok) {
          await reply(bot, msg, `✅ *APP CLOSED*\n══════════════════\n💻 \`${match.name}\` berhasil ditutup.`, { parse_mode: "Markdown" });
        } else {
          await reply(bot, msg, `❌ *Gagal menutup* \`${match.name}\`\n${closeResult.output}`, { parse_mode: "Markdown" });
        }
        return;
      }
    }
    
    await reply(bot, msg, `❌ *Tidak ditemukan*\nAplikasi \`${args}\` tidak sedang berjalan.`, { parse_mode: "Markdown" });
  } else {
    await reply(bot, msg, `❌ *Gagal mencari aplikasi*\nSistem tidak dapat membaca aplikasi berjalan.\n\nError:\n${result.output}`, { parse_mode: "Markdown" });
  }
}

async function handleFullGuide(bot, msg) {
  const guide = [
    `📖 *PANDUAN LENGKAP & DETAIL FITUR*`,
    `══════════════════`,
    ``,
    `*1. 💬 MODE NATURAL AI (CHAT BIASA)*`,
    `Kamu tidak perlu menghafal command. Cukup suruh bot pakai bahasa sehari-hari.`,
    `• _"buatkan komponen navbar React di folder components"_`,
    `• _"kenapa kode di baris 20 error? tolong perbaiki"_`,
    `• _"buatkan file konfig database"_`,
    `Bot akan otomatis membaca file, menulis kode, dan menjelaskan ke kamu.`,
    ``,
    `*2. 🖥️ TERMINAL & CLOUD SHELL*`,
    `• *Tombol Terminal* / \`/terminal\` : Mengaktifkan sesi shell interaktif. Semua chat yang dikirim akan dianggap command Windows (PowerShell). Ketik \`exit\` untuk keluar.`,
    `• *Prefix \`$\`* : Eksekusi command cepat. Contoh: \`$ npm install axios\`.`,
    `• *Berpindah Folder* : Gunakan \`$ cd nama_folder\`. Bot akan menyimpan posisi folder ini untuk command selanjutnya.`,
    ``,
    `*3. 📂 MANAJEMEN PROJECT & WORKSPACE*`,
    `• *Tombol Projects* / \`/select\` : Membuka daftar instan semua project yang ada di dalam Workspace. Tinggal klik tombol untuk pindah project.`,
    `• \`/projects\` : Membuka fitur *Folder Browser* secara interaktif.`,
    `• \`/workspace\` : Melihat folder induk saat ini.`,
    `• \`/setworkspace D:\\path\` : Mengganti folder induk tempat mencari project.`,
    ``,
    `*4. ⚙️ AI ENGINE & MODEL*`,
    `- *Tombol AI Engine* / \`/engine\` : Mengganti otak AI. Default *Claude CLI* (opus); bisa juga ganti ke Gemini API kalau diisi.`,
    ``,
    `*5. ▶️ PENGELOLAAN SERVER (DEV) & TUNNEL*`,
    `• *Tombol Dev Server* / \`/dev\` : Menjalankan \`npm run dev\` di background, jadi kamu tetap bisa chat sama bot sementara server jalan.`,
    `• \`/tunnel port\` : Menjalankan **Ngrok Tunnel** untuk *live preview* website dari HP atau jaringan publik dengan aman.`,
    `• \`/stop\` : Mematikan server background yang berjalan.`,
    `• \`/logs\` : Melihat isi output terminal dari server yang berjalan.`,
    ``,
    `*6. 💻 KONTROL LAPTOP FISIK (REMOTE)*`,
    `• \`/laptop\` : Buka dashboard Laptop Control.`,
    `• \`/apps\` : Melihat daftar aplikasi berjendela yang sedang berjalan. Kamu bisa _kill_ / menutupnya dari sini.`,
    `• *Natural Language App Control* : Buka atau tutup aplikasi dengan bahasa sehari-hari.`,
    `  › _"buka vscode"_`,
    `  › _"buka brave youtube.com"_ (Membuka browser Brave dan langsung masuk ke URL)`,
    `  › _"tutup aplikasi spotify"_`,
    `• \`/lock\` : Mengunci layar komputermu (Windows L).`,
    `• \`/shutdown\` : Mematikan komputer.`,
    ``,
    `*7. 🛠️ FITUR AUTO-FIX & VERIFY*`,
    `• *🛠 Benerin Error Ini* : Auto-analisis & fix kode berdasarkan error log.`,
    `• *🔨 Verify Build* : Menjalankan script \`build\` atau \`lint\` secara otomatis setelah AI melakukan update kode untuk memastikan tidak ada syntax yang rusak.`,
    ``,
    `══════════════════`,
    `_Tips: Jika bot terasa bingung atau nyasar, ketik \`/sync\` untuk mereset memori konteksnya._`
  ].join("\n");
  
  await sendLongMessage(bot, msg.chat.id, guide);
}

async function handleTunnel(bot, msg, args) {
  const port = parseInt(args) || 3000;
  
  await sendTyping(bot, msg.chat.id);
  try {
    const tunnel = await openPublicTunnel(port, msg);
    await reply(bot, msg, [
      `🌐 *TUNNEL ACTIVE*`,
      `══════════════════`,
      `🔌 Port: \`${port}\``,
      `🌐 URL: ${tunnel.url}`,
      ``,
      `_Buka link di atas dari HP atau laptop lain untuk melihat Live Preview._`
    ].join("\n"), { parse_mode: "Markdown" });
  } catch (error) {
    await reply(bot, msg, `❌ *Gagal Membuka Tunnel*\n══════════════════\n${error.message}`, { parse_mode: "Markdown" });
  }
}

async function handleVisualDashboard(bot, msg) {
  const ramUsed = (os.totalmem() - os.freemem()) / 1024 ** 3;
  const ramFree = os.freemem() / 1024 ** 3;
  const chartConfig = {
    type: 'doughnut',
    data: {
      labels: ['Used RAM (GB)', 'Free RAM (GB)'],
      datasets: [{ data: [ramUsed.toFixed(1), ramFree.toFixed(1)], backgroundColor: ['#ef4444', '#10b981'], borderWidth: 0 }]
    },
    options: {
      title: { display: true, text: 'System Memory', fontColor: '#fff', fontSize: 24 },
      legend: { labels: { fontColor: '#fff', fontSize: 16 } },
      plugins: { datalabels: { color: '#fff', font: { size: 18 } } }
    }
  };
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&bkg=transparent&w=500&h=300`;

  const caption = [
    `📈 *VISUAL SYSTEM DASHBOARD*`,
    `══════════════════`,
    `🖥 **OS:** \`${os.type()} ${os.release()}\``,
    `🧠 **CPU:** \`${os.cpus()[0].model}\``,
    `💻 **RAM:** \`${ramUsed.toFixed(1)}GB / ${(os.totalmem() / 1024 ** 3).toFixed(1)}GB\``,
    `⏱ **Uptime:** \`${(os.uptime() / 3600).toFixed(1)} hrs\``
  ].join("\n");

  await bot.sendPhoto(msg.chat.id, chartUrl, {
    caption,
    parse_mode: 'Markdown',
    ...actionKeyboard([
      [{ text: "🔄 Refresh Dashboard", callback_data: "cmd_dashboard_visual" }],
      [{ text: "◀️ Menu Utama", callback_data: "cmd_main_menu" }]
    ])
  }).catch(async (e) => {
    await reply(bot, msg, `Error memuat grafik: ${e.message}`);
  });
}

async function handleGitMenu(bot, msg) {
  const statusResult = await runCommand("git status -s", getActiveProjectDir());
  let output = statusResult.ok ? statusResult.output.trim() : "Bukan repository git atau error.";
  if (statusResult.ok && !output) output = "✅ Working tree clean (tidak ada perubahan).";

  const rows = [
    [
      { text: "➕ Stage All", callback_data: "cmd_git_add" },
      { text: "📝 Auto Commit", callback_data: "cmd_git_commit" }
    ],
    [
      { text: "🚀 Push", callback_data: "cmd_git_push" },
      { text: "⬇️ Pull", callback_data: "cmd_git_pull" }
    ],
    [
      { text: "◀️ Coding Console", callback_data: "cmd_remote_coding" }
    ]
  ];

  const text = [
    `🐙 *GIT VISUAL MANAGER*`,
    `══════════════════`,
    `📂 \`${getActiveProjectName()}\``,
    ``,
    `*Status:*`,
    `\`\`\`\n${output.slice(0, 500)}\n\`\`\``
  ].join("\n");

  await reply(bot, msg, text, { parse_mode: "Markdown", ...actionKeyboard(rows) });
}

async function handleTree(bot, msg) {
  const tree = await listProjectTree(getActiveProjectDir());
  await reply(bot, msg, tree);
}

async function handleSysinfo(bot, msg) {
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const cpu = os.cpus()[0].model;
  const uptime = (os.uptime() / 3600).toFixed(2);
  const info = [
    `💻 *SYSTEM INFO*`,
    `══════════════════`,
    `⚙️ CPU: \`${cpu}\``,
    `🧠 RAM: \`${freeMem} GB free / ${totalMem} GB\``,
    `⏱ Uptime: \`${uptime} hours\``,
    `💾 OS: \`${os.type()} ${os.release()}\``
  ].join("\n");
  await reply(bot, msg, info, { parse_mode: "Markdown" });
}

async function handleMediaMenu(bot, msg) {
  const rows = [
    [
      { text: "🔇 Mute", callback_data: "cmd_media_mute" },
      { text: "🔉 Vol -", callback_data: "cmd_media_voldown" },
      { text: "🔊 Vol +", callback_data: "cmd_media_volup" }
    ],
    [
      { text: "⏮ Prev", callback_data: "cmd_media_prev" },
      { text: "⏯ Play/Pause", callback_data: "cmd_media_play" },
      { text: "⏭ Next", callback_data: "cmd_media_next" }
    ],
    [
      { text: "◀️ Laptop Control", callback_data: "cmd_remote_laptop" }
    ]
  ];
  await reply(bot, msg, `🔊 *MEDIA & VOLUME CONTROL*\n══════════════════\n_Gunakan tombol di bawah untuk mengontrol volume dan media player laptop secara instan._`, { parse_mode: "Markdown", ...actionKeyboard(rows) });
}

async function handlePowerMenu(bot, msg) {
  const rows = [
    [
      { text: "📴 Shutdown PC", callback_data: "cmd_pc_shutdown" },
      { text: "🔄 Restart PC", callback_data: "cmd_pc_restart" }
    ],
    [
      { text: "◀️ Laptop Control", callback_data: "cmd_remote_laptop" }
    ]
  ];
  await reply(bot, msg, `⚡ *POWER CONTROL PANEL*\n══════════════════\n_Pilih aksi daya di bawah. Aksi shutdown/restart akan memiliki jeda 10 detik._`, { parse_mode: "Markdown", ...actionKeyboard(rows) });
}

async function handleGitCommitWithAi(bot, msg) {
  const projectDir = getActiveProjectDir();
  await sendTyping(bot, msg.chat.id);
  
  const diffResult = await runCommand("git diff --cached", projectDir);
  let diff = diffResult.ok ? diffResult.output.trim() : "";
  
  if (!diff) {
    const diffUnstaged = await runCommand("git diff", projectDir);
    diff = diffUnstaged.ok ? diffUnstaged.output.trim() : "";
    if (diff) {
      await reply(bot, msg, "⚠️ *Tidak ada file di-stage!*\nSilakan klik tombol *➕ Stage All* terlebih dahulu sebelum melakukan commit.", { parse_mode: "Markdown" });
      return;
    } else {
      await reply(bot, msg, "✅ *Bersih!*\nTidak ada perubahan untuk di-stage maupun di-commit.", { parse_mode: "Markdown" });
      return;
    }
  }

  await progress(bot, msg, "🧠 _A.I. sedang menganalisis diff dan menyusun commit message..._");
  
  const prompt = `Buatkan git commit message 1 baris yang sangat singkat, jelas, dan profesional dalam Bahasa Inggris berdasarkan diff perubahan kodingan berikut. Jangan berikan teks/penjelasan apa pun selain isi commit message itu sendiri:\n\n${diff.slice(0, 4000)}`;
  
  let commitMsg = "Update via O-W-O Familiar";
  try {
    const agentInstructions = await readAgentInstructions(projectDir).catch(() => "");
    const aiMsg = await chat([
      {
        role: "system",
        content: [
          `Kamu adalah ${config.agentName || "O-W-O"}, Telegram Familiar / Coding Agent.`,
          "Ikuti SOUL.md dan AGENT.md. Output hanya git commit message Bahasa Inggris.",
          agentInstructions ? `\n=== SOUL.md / AGENT.md ===\n${agentInstructions}` : ""
        ].filter(Boolean).join("\n")
      },
      { role: "user", content: prompt }
    ]);
    if (aiMsg && aiMsg.trim()) {
      commitMsg = aiMsg.trim().replace(/^["']|["']$/g, "").replace(/\n/g, " ").trim();
    }
  } catch (err) {
    // Fallback
  }

  const cleanCommitMsg = commitMsg.replace(/"/g, '\\"');
  await handleRun(bot, msg, `git commit -m "AI: ${cleanCommitMsg}"`);
}

async function handlePCControl(bot, msg, action, { skipSafe = false } = {}) {
  if (!skipSafe && await isSafeModeEnabled() && ["shutdown", "restart"].includes(action)) {
    await reply(
      bot,
      msg,
      [
        `⚠️ *CONFIRM SYSTEM ACTION*`,
        `══════════════════`,
        `🎯 Action: \`${action}\``,
        ``,
        `_Safe Mode aktif. Konfirmasi dulu sebelum aksi ini dijalankan._`
      ].join("\n"),
      actionKeyboard([
        [{ text: `Ya, ${action}`, callback_data: createSafeActionCallback("pc_control", { action }) }],
        [{ text: "Batal", callback_data: "safe_cancel" }]
      ])
    );
    return;
  }

  if (action === "lock") {
    await reply(bot, msg, `🔒 *PC LOCKED*\n_Layar laptop berhasil dikunci._`, { parse_mode: "Markdown" });
    await runShellCommand("rundll32.exe user32.dll,LockWorkStation", getActiveProjectDir());
  } else if (action === "shutdown") {
    await reply(bot, msg, `📴 *SHUTDOWN INITIATED*\n_PC akan mati dalam 10 detik..._`, { parse_mode: "Markdown" });
    await runShellCommand("shutdown /s /t 10", getActiveProjectDir());
  } else if (action === "restart") {
    await reply(bot, msg, `🔄 *RESTART INITIATED*\n_PC akan restart dalam 10 detik..._`, { parse_mode: "Markdown" });
    await runShellCommand("shutdown /r /t 10", getActiveProjectDir());
  } else if (action === "openterminal") {
    const tipText = [
      "💻 Membuka jendela terminal (PowerShell) fisik di layar laptop...",
      "",
      "💡 *Tips Menjalankan Command via Telegram:*",
      "Kamu tidak perlu membuka terminal laptop jika hanya ingin mengeksekusi command dasar! Cukup gunakan awalan `$` di bot ini.",
      "",
      "Contoh Penggunaan:",
      "• `$ cd D:/PROJECT/smartlife_app/backend` *(Berpindah folder)*",
      "• `$ npm install` *(Menginstall library)*",
      "• `$ npm run dev` *(Menjalankan server)*",
      "• `$ git status` *(Mengecek git repo)*",
      "",
      "_Semua command dengan `$ ` akan langsung dieksekusi di laptop dan outputnya dikirim ke sini!_"
    ].join("\n");
    await reply(bot, msg, tipText, { parse_mode: "Markdown" });
    spawn("cmd", [], { shell: true, cwd: getActiveProjectDir(), detached: true, stdio: "ignore" }).unref();
  }
}

async function handleKillPort(bot, msg, port) {
  if (!port || isNaN(port)) throw new Error("Format: /kill 3000");
  await reply(bot, msg, `🔌 _Mencoba mematikan port ${port}..._`, { parse_mode: "Markdown" });
  const result = await runShellCommand(`npx kill-port ${port}`, getActiveProjectDir());
  await reply(bot, msg, result.ok ? `✅ *Port ${port} berhasil dimatikan.*` : `❌ *Gagal mematikan port:*\n${result.output}`, { parse_mode: "Markdown" });
}

async function handlePortTools(bot, msg) {
  const ports = [3000, 3001, 5173, 4173, 5000, 8000, 8080];
  const rows = [];
  for (let index = 0; index < ports.length; index += 2) {
    rows.push(ports.slice(index, index + 2).map((port) => ({
      text: `Kill :${port}`,
      callback_data: `kill_port_${port}`
    })));
  }
  rows.push([{ text: "◀️ Coding Console", callback_data: "cmd_remote_coding" }]);
  await reply(
    bot,
    msg,
    [
      `🔌 *PORT TOOLS*`,
      `══════════════════`,
      `Pilih port dev server yang ingin dimatikan.`,
      ``,
      `• \`3000\` Next.js`,
      `• \`5173\` Vite`,
      `• \`8080\` Backend / Dev Server`,
      ``,
      `_Klik tombol di bawah untuk kill port._`
    ].join("\n"),
    { parse_mode: "Markdown", ...actionKeyboard(rows) }
  );
}

async function handleLogCenter(bot, msg) {
  await reply(
    bot,
    msg,
    [
      `📋 *LOG CENTER*`,
      `══════════════════`,
      `Pilih sumber log yang ingin dibaca.`,
      ``,
      `_Output log akan dikirim ke chat ini._`
    ].join("\n"),
    {
      parse_mode: "Markdown",
      ...actionKeyboard([
        [
          { text: "📝 Command Logs", callback_data: "logs_command" },
          { text: "🤖 Bot Logs", callback_data: "logs_bot" }
        ],
        [
          { text: "📡 Dev Server Logs", callback_data: "logs_dev" },
          { text: "◀️ Back", callback_data: "cmd_remote_coding" }
        ]
      ])
    }
  );
}

async function handleBotLogs(bot, msg) {
  const content = await fs.readFile(config.appLogFile, "utf8").catch(() => "Belum ada app log.");
  await sendLongMessage(bot, msg.chat.id, truncateOutput(content.slice(-16000), config.maxOutputChars));
}

async function handleSafeMode(bot, msg) {
  const enabled = await isSafeModeEnabled();
  await reply(
    bot,
    msg,
    [
      `🛡 *SAFE MODE*`,
      `══════════════════`,
      `Status: ${enabled ? "🟢 \`ON\`" : "🔴 \`OFF\`"}`,
      ``,
      `_Saat ON, aksi sensitif (close app, buka IDE, shutdown/restart) memerlukan konfirmasi._`
    ].join("\n"),
    {
      parse_mode: "Markdown",
      ...actionKeyboard([
        [
          { text: "🟢 Safe Mode ON", callback_data: "safe_mode_on" },
          { text: "🔴 Safe Mode OFF", callback_data: "safe_mode_off" }
        ],
        [{ text: "◀️ Back", callback_data: "cmd_remote_coding" }]
      ])
    }
  );
}

async function handleZipProject(bot, msg) {
  const projectDir = getActiveProjectDir();
  const projectName = path.basename(projectDir);
  const zipName = `${projectName}_backup_${Date.now()}.zip`;
  const zipPath = path.join(os.tmpdir(), zipName);
  
  await reply(bot, msg, `📦 _Sedang membuat ZIP project untuk_ \`${projectName}\`_..._`, { parse_mode: "Markdown" });
  const psCommand = `Compress-Archive -Path (Get-ChildItem -Path '${projectDir}' -Exclude 'node_modules', '.git') -DestinationPath '${zipPath}' -Force`;
  const result = await runShellCommand(`powershell -Command "${psCommand}"`, projectDir);
  
  if (!fsSync.existsSync(zipPath)) throw new Error(`Gagal membuat ZIP: ${result.output}`);
  await bot.sendDocument(msg.chat.id, zipPath, { caption: `✅ Backup ZIP berhasil: ${projectName}` });
  await fs.unlink(zipPath).catch(()=>{});
}

async function handleLiveLogs(bot, msg) {
  const running = listRunningProcesses();
  if (running.length === 0) throw new Error("Tidak ada proses yang berjalan di background.");
  const proc = running[running.length - 1];
  const logs = proc.output ? proc.output.slice(-1500) : "Tidak ada output.";
  const safeLogs = logs.replace(/```/g, "'''").replace(/`/g, "'");
  try {
    await sendLongMessage(bot, msg.chat.id, `📋 *LIVE LOGS* \`${(proc.label || "process").replace(/`/g, "'")}\`\n══════════════════\n\`\`\`\n${safeLogs}\n\`\`\``, { parse_mode: "Markdown" });
  } catch {
    await sendLongMessage(bot, msg.chat.id, `LIVE LOGS [${proc.label}]\n\n${logs}`);
  }
}

async function handleTerminalToggle(bot, msg) {
  const userId = msg.from?.id;
  if (isShellMode(userId)) {
    exitShellMode(userId);
    await bot.sendMessage(msg.chat.id, [
      `🔴 *TERMINAL DISCONNECTED*`,
      `══════════════════`,
      `_Kembali ke AI mode. Ketik /terminal untuk masuk lagi._`,
    ].join("\n"), { parse_mode: "Markdown" });
  } else {
    enterShellMode(userId);
    const shellName = shellPreference.get(String(userId)) || config.defaultShell;
    const shellLabel = shellLabelOf(shellName);
    await bot.sendMessage(msg.chat.id, [
      `🟢 *TERMINAL CONNECTED*`,
      `══════════════════`,
      `📂 \`${getActiveProjectDir()}\``,
      `🐚 Shell: \`${shellLabel}\``,
      ``,
      `_Semua pesan = ${shellLabel} command._`,
      `_Ganti shell: \`/shell powershell|cmd|bash\`_`,
      `_Ketik \`exit\` untuk keluar._`,
    ].join("\n"), { parse_mode: "Markdown" });
  }
}

function shellLabelOf(shell) {
  if (shell === "cmd") return "CMD";
  if (shell === "bash") return "Git Bash";
  return "PowerShell";
}

async function handleShellSelect(bot, msg, args) {
  const userId = String(msg.from?.id || "");
  const value = String(args || "").trim().toLowerCase();
  if (!value) {
    const current = shellPreference.get(userId) || config.defaultShell;
    await reply(
      bot,
      msg,
      [
        "*Shell aktif*",
        "------------------",
        `Sekarang: \`${shellLabelOf(current)}\``,
        "",
        "Pilih shell:",
        "`/shell powershell` — Windows PowerShell / pwsh 7",
        "`/shell cmd` — cmd.exe legacy",
        "`/shell bash` — Git Bash (butuh Git for Windows)"
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }
  const map = {
    powershell: "powershell", ps: "powershell", pwsh: "powershell",
    cmd: "cmd", "cmd.exe": "cmd", command: "cmd",
    bash: "bash", "git-bash": "bash", gitbash: "bash"
  };
  const target = map[value];
  if (!target) {
    await reply(bot, msg, "Pilihan: `powershell`, `cmd`, `bash`.", { parse_mode: "Markdown" });
    return;
  }
  if (target === "bash" && process.platform === "win32") {
    // Quick sanity check supaya error gak baru ketauan saat command pertama.
    try {
      const { runShellCommand } = await import("../system/terminal.js");
      const probe = await runShellCommand("echo hello", getActiveProjectDir(), { shell: "bash", userId });
      if (!probe.ok) {
        await reply(
          bot,
          msg,
          [
            "⚠️ Git Bash tidak terdeteksi.",
            `\`${truncateOutput(probe.output, 400)}\``,
            "",
            "Install Git for Windows atau set `GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe` di `.env`."
          ].join("\n"),
          { parse_mode: "Markdown" }
        );
        return;
      }
    } catch (err) {
      await reply(bot, msg, `⚠️ Git Bash gagal: \`${err.message}\``, { parse_mode: "Markdown" });
      return;
    }
  }
  shellPreference.set(userId, target);
  await reply(bot, msg, `✅ Shell aktif: \`${shellLabelOf(target)}\``, { parse_mode: "Markdown" });
}

async function handleRead(bot, msg, args) {
  if (!args) throw new Error("Format: /read path/file.js");
  const projectDir = getActiveProjectDir();
  const file = await readProjectFile(projectDir, args);
  await recordFileOpen({ projectDir, filePath: file.relativePath });
  await reply(
    bot,
    msg,
    [
      `📄 *FILE READ*`,
      `══════════════════`,
      `📂 \`${file.relativePath}\` (${file.size} bytes)`,
      ``,
      `\`\`\`\n${truncateOutput(file.content, config.maxOutputChars)}\n\`\`\``
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleFiles(bot, msg) {
  await handleTree(bot, msg);
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const match = text.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return match ? match[1] : text;
}

async function handleWrite(bot, msg, args) {
  const tokens = parseCommandLine(args);
  if (tokens.length < 2) throw new Error("Format: /write path/file.js <content>");
  const filePath = tokens[0];
  const content = stripCodeFence(args.slice(args.indexOf(filePath) + filePath.length).trim());
  if (!content) throw new Error("Content kosong.");

  const projectDir = getActiveProjectDir();
  const existing = await readProjectFile(projectDir, filePath).catch(() => null);
  const normalizedPath = existing?.relativePath || filePath;
  const type = existing ? "edit" : "create";
  const diff = createUnifiedDiff(existing?.content || "", content, normalizedPath);
  const pending = {
    projectDir,
    filePath: normalizedPath,
    type,
    content,
    summary: `exact write ${normalizedPath}`,
    createdAt: Date.now()
  };

  const key = String(msg.from?.id);
  pendingEdits.set(key, pending);
  await setPendingEdit(msg.from?.id, pending);

  await reply(bot, msg, [
    header(type === "create" ? "Write preview" : "Overwrite preview", normalizedPath, { icon: "WRITE" }),
    existing ? kv("current size", `${existing.size} bytes`) : "_File baru._",
    kv("new size", `${content.length} chars`),
    "",
    "*Diff*",
    "```diff\n" + truncateOutput(diff, 2600).replace(/```/g, "'''") + "\n```",
    "",
    "_Ketik /confirmedit untuk menerapkan, atau /canceledit untuk batal._"
  ].filter(Boolean).join("\n"), { parse_mode: "Markdown" });
}

async function handleDownload(bot, msg, args) {
  if (!args) throw new Error("Format: /download path/file.js");
  const projectDir = getActiveProjectDir();
  const info = await getProjectFileInfo(projectDir, args);
  
  await recordFileOpen({ projectDir, filePath: info.relativePath });
  const filePath = info.absolutePath;
  args = info.relativePath;
  
  await bot.sendDocument(msg.chat.id, filePath, { caption: `📄 File: ${args}` });
}

async function handleOutline(bot, msg, args) {
  if (!args) throw new Error("Format: /outline path/file.js");
  const projectDir = getActiveProjectDir();
  const file = await readProjectFile(projectDir, args, { forAi: true });
  await recordFileOpen({ projectDir, filePath: file.relativePath });
  await sendTyping(bot, msg.chat.id);
  const answer = await askProjectQuestion({
    projectDir,
    question: `Buatkan outline/kerangka dari file ${args}. Cukup daftar fungsi, class, komponen, dan deskripsi singkatnya. Jangan berikan kode utuh. Berikut kodenya:\n\n${file.content}`
  });
  await reply(bot, msg, `🦴 *Outline* \`${args}\`\n══════════════════\n\n${answer}`, { parse_mode: "Markdown" });
}

async function handlePush(bot, msg) {
  const projectDir = getActiveProjectDir();
  const status = await ensureGitRepo(projectDir, { needRemote: true });
  if (!status.ok) {
    await reply(bot, msg, `⚠️ *Push tidak bisa dijalankan*\n${status.reason}`, { parse_mode: "Markdown" });
    return;
  }
  const gh = parseGithubRemote(status.remote);
  const target = gh ? `${gh.owner}/${gh.repo} (branch ${status.branch})` : `${status.remote} (${status.branch})`;
  const ticket = await createApproval({
    service: "git",
    actionId: "git:push",
    action: "git push",
    target,
    payload: { branch: status.branch, remote: status.remote },
    userId: msg.from?.id,
    chatId: msg.chat.id
  });
  await reply(bot, msg, formatApprovalMessage(ticket), { parse_mode: "Markdown" });
}

async function handleFormat(bot, msg) {
  await reply(bot, msg, `🧹 _Merapikan kode (Prettier/ESLint)..._`, { parse_mode: "Markdown" });
  let result = await runShellCommand("npx prettier --write .", getActiveProjectDir());
  if (!result.ok) {
    result = await runShellCommand("npm run lint -- --fix", getActiveProjectDir());
  }
  await reply(bot, msg, result.ok
    ? `✨ *FORMAT COMPLETE*\n_Kode berhasil dirapikan._`
    : `⚠️ *FORMAT FAILED*\n\`\`\`\n${result.output.slice(0, 500)}\n\`\`\``,
    { parse_mode: "Markdown" });
}

async function handleAsk(bot, msg, args) {
  if (!args) {
    await reply(bot, msg, [
      `❓ *ASK AI*`,
      `══════════════════`,
      `_Format:_ \`/ask pertanyaan kamu\``,
      ``,
      `_Atau ketik langsung pertanyaanmu tanpa command._`
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }
  const fixAliasMatch = args.trim().match(/^\/{1,2}fix(?:\s+(.+))?$/i);
  if (fixAliasMatch) {
    await handleFix(bot, msg, fixAliasMatch[1] || "");
    return;
  }

  const rate = checkRateLimit(`ai:${msg.from.id}`, config.aiRateLimit);
  if (!rate.allowed) {
    await reply(bot, msg, `Rate limit AI aktif. Coba lagi dalam ${formatRetryAfter(rate.retryAfterMs)}.`);
    return;
  }

  await sendTyping(bot, msg.chat.id);
  const projectDir = getActiveProjectDir();
  const answer = await askProjectQuestion({ projectDir, question: args });
  await rememberConversation({
    userId: msg.from?.id,
    role: "assistant",
    text: answer,
    projectDir
  }).catch(() => {});
  await reply(bot, msg, answer);
}

async function detectProjectProfile(projectDir) {
  const packageFile = await readProjectFile(projectDir, "package.json", { maxChars: 40000 }).catch(() => null);
  if (!packageFile) {
    const has = (name) => fsSync.existsSync(path.join(projectDir, name));
    if (has("pubspec.yaml")) {
      return { framework: "Flutter/Dart", devCommand: "flutter run", buildCommand: "flutter build apk", lintCommand: "flutter analyze", testCommand: "flutter test" };
    }
    if (has("requirements.txt") || has("pyproject.toml")) {
      return { framework: "Python", devCommand: has("main.py") ? "python main.py" : "", buildCommand: "", lintCommand: "", testCommand: has("pytest.ini") ? "pytest" : "" };
    }
    if (has("Cargo.toml")) {
      return { framework: "Rust", devCommand: "cargo run", buildCommand: "cargo build", lintCommand: "cargo clippy", testCommand: "cargo test" };
    }
    return {};
  }

  try {
    const pkg = JSON.parse(packageFile.content);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const framework = deps.next ? "Next.js" : deps.vite ? "Vite" : deps.react ? "React" : pkg.type === "module" ? "Node.js ESM" : "Node.js";
    const scripts = pkg.scripts || {};
    return {
      framework,
      devCommand: scripts.dev ? "npm run dev" : "",
      checkCommand: scripts.check ? "npm run check" : "",
      buildCommand: scripts.build ? "npm run build" : "",
      lintCommand: scripts.lint ? "npm run lint" : "",
      testCommand: scripts.test ? "npm run test" : ""
    };
  } catch {
    return {};
  }
}

async function chooseVerifyCommand(projectDir) {
  const profile = await detectProjectProfile(projectDir);
  await updateProjectProfile(projectDir, profile);
  return profile.checkCommand || profile.buildCommand || profile.lintCommand || profile.testCommand || "";
}

async function rememberRecentProject(projectDir) {
  const resolved = path.resolve(projectDir);
  const current = Array.isArray(await getLast("recentProjects")) ? await getLast("recentProjects") : [];
  const next = [resolved, ...current.filter((item) => path.resolve(item) !== resolved)].slice(0, 8);
  await setLast("recentProjects", next);
}

async function togglePinnedProject(projectDir) {
  const resolved = path.resolve(projectDir);
  const current = Array.isArray(await getLast("pinnedProjects")) ? await getLast("pinnedProjects") : [];
  const exists = current.some((item) => path.resolve(item) === resolved);
  const next = exists ? current.filter((item) => path.resolve(item) !== resolved) : [resolved, ...current].slice(0, 10);
  await setLast("pinnedProjects", next);
  return !exists;
}

async function handleProjectTools(bot, msg) {
  const projectDir = getActiveProjectDir();
  const profile = await detectProjectProfile(projectDir);
  const rows = [];
  const commands = [
    ["Dev", profile.devCommand],
    ["Check", profile.checkCommand],
    ["Build", profile.buildCommand],
    ["Lint", profile.lintCommand],
    ["Test", profile.testCommand]
  ].filter(([, command]) => command);

  for (let i = 0; i < commands.length; i += 2) {
    rows.push(commands.slice(i, i + 2).map(([label, command]) => ({
      text: `${label}: ${command}`,
      callback_data: `run_cmd_${command}`
    })));
  }
  rows.push([{ text: "Pin / Unpin Project", callback_data: createFolderCallback("pin", projectDir) }]);
  rows.push([{ text: "Recent Projects", callback_data: "cmd_recent_projects" }, { text: "Pinned Projects", callback_data: "cmd_pinned_projects" }]);
  rows.push([{ text: "◀️ Coding Console", callback_data: "cmd_remote_coding" }]);

  await reply(
    bot,
    msg,
    [
      `🛠 *PROJECT TOOLS*`,
      `══════════════════`,
      `📂 Project: \`${path.basename(projectDir)}\``,
      `📍 Path: \`${formatFolderPath(projectDir)}\``,
      `⚙️ Engine: \`${profile.framework || "Unknown"}\``,
      ``,
      commands.length ? `_${commands.length} auto-command terdeteksi._` : `_Belum ada command otomatis yang terdeteksi._`
    ].join("\n"),
    { parse_mode: "Markdown", ...actionKeyboard(rows) }
  );
}

function projectListKeyboard(projects, emptyCallback = "cmd_project_tools") {
  const rows = projects.map((projectDir) => [
    { text: `🚀 Pilih ${path.basename(projectDir)}`, callback_data: createFolderCallback("activate", projectDir) }
  ]);
  rows.push([{ text: "◀️ Project Tools", callback_data: emptyCallback }]);
  return actionKeyboard(rows);
}

async function handleRecentProjects(bot, msg) {
  const projects = (Array.isArray(await getLast("recentProjects")) ? await getLast("recentProjects") : [])
    .filter((projectDir) => fsSync.existsSync(projectDir));
  await reply(
    bot,
    msg,
    [
      `🕒 *RECENT PROJECTS*`,
      `══════════════════`,
      projects.length ? projects.map((projectDir, index) => `${index + 1}. \`${formatFolderPath(projectDir)}\``).join("\n") : "_Belum ada recent project._"
    ].join("\n"),
    { parse_mode: "Markdown", ...projectListKeyboard(projects) }
  );
}

async function handlePinnedProjects(bot, msg) {
  const projects = (Array.isArray(await getLast("pinnedProjects")) ? await getLast("pinnedProjects") : [])
    .filter((projectDir) => fsSync.existsSync(projectDir));
  await reply(
    bot,
    msg,
    [
      `📌 *PINNED PROJECTS*`,
      `══════════════════`,
      projects.length ? projects.map((projectDir, index) => `${index + 1}. \`${formatFolderPath(projectDir)}\``).join("\n") : "_Belum ada pinned project._"
    ].join("\n"),
    { parse_mode: "Markdown", ...projectListKeyboard(projects) }
  );
}

async function findProjectFolders(query, { maxResults = 20, maxVisited = 2500 } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) throw new Error("Format: /findproject keyword");
  const drives = await listAvailableDrives();
  const queue = [...drives];
  const results = [];
  let visited = 0;

  while (queue.length && results.length < maxResults && visited < maxVisited) {
    const current = queue.shift();
    visited += 1;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("$")) continue;
      const child = path.join(current, entry.name);
      const lowered = entry.name.toLowerCase();
      if (lowered.includes(needle)) results.push(child);
      if (!["node_modules", ".git", "AppData", "Windows", "Program Files", "Program Files (x86)"].includes(entry.name)) {
        queue.push(child);
      }
      if (results.length >= maxResults || queue.length + visited >= maxVisited) break;
    }
  }

  return results;
}

async function handleFindProject(bot, msg, args) {
  const results = await findProjectFolders(args);
  const rows = results.map((folderPath) => [
    { text: path.basename(folderPath), callback_data: createFolderCallback("browse", folderPath) }
  ]);
  rows.push([{ text: "Main Menu", callback_data: "cmd_main_menu" }]);
  await reply(
    bot,
    msg,
    [
      `🔍 *FIND PROJECT*`,
      `══════════════════`,
      `🎯 Query: \`${args}\``,
      `📁 Results: \`${results.length}\``,
      ``,
      results.length ? results.map((folderPath, index) => `${index + 1}. \`${formatFolderPath(folderPath)}\``).join("\n") : "_Tidak ada folder cocok ditemukan._"
    ].join("\n"),
    { parse_mode: "Markdown", ...actionKeyboard(rows) }
  );
}

async function runAutoVerify(projectDir, userId) {
  const command = await chooseVerifyCommand(projectDir);
  if (!command) {
    return "Auto verify dilewati: tidak ada script check/build/lint/test di package.json.";
  }

  const result = await runCommand(command, projectDir, { userId: `verify:${userId}` });
  await setLast("command", command);
  if (!result.ok) await setLast("error", result.output);
  else await setLast("error", "");
  return [
    `Auto verify: ${command}`,
    result.ok ? "Status: berhasil" : "Status: gagal",
    "",
    result.output
  ].join("\n");
}

async function stageEditPreview(bot, msg, { filePath, instruction, type = "edit", sourceLabel = "teks command", inlineData = null }) {
  const projectDir = getActiveProjectDir();
  const file = await readProjectFile(projectDir, filePath, { forAi: true });
  await sendTyping(bot, msg.chat.id);
  let proposal;
  try {
    proposal = type === "fix" ? await proposeFileFix({
      projectDir,
      filePath: file.relativePath,
      currentContent: file.content,
      errorText: instruction,
      inlineData
    }) : await proposeFileEdit({
      projectDir,
      filePath: file.relativePath,
      currentContent: file.content,
      instruction,
      inlineData
    });
  } catch (err) {
    await reply(bot, msg, [
      header(`AI ${type} failed`, "", { icon: T.fail }),
      kv("file", file.relativePath),
      T.fail + "  `" + err.message + "`",
      "",
      `_Cek koneksi atau ganti model via_ \`/engine\`_._`
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }
  const diff = createUnifiedDiff(file.content, proposal.content, file.relativePath);

  // Simpan preview sebagai pending edit (tidak langsung menulis file).
  const key = String(msg.from?.id);
  const pending = {
    projectDir: getActiveProjectDir(),
    filePath: file.relativePath,
    type,
    content: proposal.content,
    summary: proposal.summary,
    createdAt: Date.now()
  };

  // Simpan ke memori runtime dan persist ke memory.json
  pendingEdits.set(key, pending);
  await setPendingEdit(msg.from?.id, pending).catch(() => {});

  await reply(
    bot,
    msg,
    [
      header(type === "fix" ? "Fix preview" : "Edit preview", "", { icon: T.ok }),
      kv("file", file.relativePath),
      `_${proposal.summary}_`,
      "",
      "*Diff*",
      "```diff\n" + diff + "\n```",
      "",
      "_Untuk menerapkan perubahan, ketik /confirmedit. Untuk batal, ketik /canceledit._"
    ].join("\n"),
    { parse_mode: "Markdown", ...rollbackKeyboard() }
  );
}

async function stageCreatePreview(bot, msg, { filePath, instruction, sourceLabel = "natural chat", inlineData = null }) {
  const projectDir = getActiveProjectDir();
  await sendTyping(bot, msg.chat.id);
  let proposal;
  try {
    proposal = await proposeNewFile({
      projectDir,
      filePath,
      instruction,
      inlineData
    });
  } catch (err) {
    await reply(bot, msg, [
      header("AI create failed", "", { icon: T.fail }),
      kv("file", filePath),
      T.fail + "  `" + err.message + "`",
      "",
      `_Cek koneksi atau ganti model via_ \`/engine\`_._`
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }
  const diff = createUnifiedDiff("", proposal.content, filePath);

  // Simpan preview sebagai pending create (tidak langsung menulis file).
  const key = String(msg.from?.id);
  const pending = {
    projectDir: getActiveProjectDir(),
    filePath,
    type: "create",
    content: proposal.content,
    summary: proposal.summary,
    createdAt: Date.now()
  };

  pendingEdits.set(key, pending);
  await setPendingEdit(msg.from?.id, pending).catch(() => {});

  await reply(
    bot,
    msg,
    [
      header("Create preview", "", { icon: T.ok }),
      kv("file", filePath),
      `_${proposal.summary}_`,
      "",
      "*Content*",
      code(truncateOutput(proposal.content, 2000)),
      "",
      "_Untuk menerapkan file baru, ketik /confirmedit. Untuk batal, ketik /canceledit._"
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown", ...rollbackKeyboard() }
  );
}

async function handleEdit(bot, msg, args) {
  const { filePath, instruction } = splitPathAndInstruction(args);
  await stageEditPreview(bot, msg, { filePath, instruction, type: "edit" });
}

async function handleFix(bot, msg, args) {
  let { filePath, instruction } = splitFixArgs(args, msg);
  const replyText = getReplyText(msg);
  if (!filePath) {
    filePath = await inferFileFromText(getActiveProjectDir(), `${replyText}\n${instruction}`);
  }
  if (!filePath) {
    filePath = await getLast("filePath");
  }
  if (!filePath) throw new Error("File target belum jelas. Reply error yang berisi path file, atau kirim /fix path/file.js.");
  await setLast("error", instruction || replyText);
  await stageEditPreview(bot, msg, {
    filePath,
    instruction,
    type: "fix",
    sourceLabel: msg.reply_to_message ? "pesan yang direply" : "teks command"
  });
}

async function handleConfirmEdit(bot, msg) {
  const key = String(msg.from.id);
  const pending = pendingEdits.get(key) || (await getPendingEdit(key));
  if (isExpiredPending(pending)) {
    pendingEdits.delete(key);
    await clearPendingEdit(key);
    await reply(bot, msg, "Tidak ada pending edit aktif atau preview sudah kedaluwarsa.");
    return;
  }

  try {
    await assertPendingEditFresh(pending);
  } catch (error) {
    pendingEdits.delete(key);
    await clearPendingEdit(key);
    await reply(bot, msg, error.message);
    return;
  }

  const result = pending.type === "create"
    ? await createProjectFile(pending.projectDir, pending.filePath, pending.content)
    : await writeProjectFileWithBackup(pending.projectDir, pending.filePath, pending.content);
  pendingEdits.delete(key);
  await clearPendingEdit(key);
  if (result.backup) {
    await recordBackup({
      projectDir: pending.projectDir,
      filePath: result.relativePath,
      backupPath: result.backup.backupPath,
      action: pending.type
    });
  }
  await recordFileMutation({ projectDir: pending.projectDir, filePath: result.relativePath, action: pending.type });
  await recordTask({
    type: pending.type,
    projectDir: pending.projectDir,
    filePath: result.relativePath,
    summary: pending.summary,
    status: "confirmed"
  });

  // Remember conversation for project context and attempt auto-commit
  await rememberConversation({
    userId: msg.from?.id,
    role: "assistant",
    text: `[${pending.type}] ${pending.filePath}: ${pending.summary}`,
    projectDir: pending.projectDir
  }).catch(() => {});

  try {
    await autoGitCommit(pending.projectDir, pending.summary);
  } catch {
    // ignore commit failures
  }

  const verifyText = await runAutoVerify(pending.projectDir, msg.from.id).catch((error) => `Auto verify gagal dijalankan: ${error.message}`);

  await reply(
    bot,
    msg,
    [
      `✅ *EDIT APPLIED*`,
      `══════════════════`,
      `📄 File: \`${result.relativePath}\``,
      `📖 Summary: ${pending.summary}`,
      result.backup ? `📦 Backup: \`${result.backup.backupPath}\`` : "📦 Backup: _tidak ada file lama_",
      ``,
      truncateOutput(verifyText, 2200)
    ].join("\n"),
    { parse_mode: "Markdown", ...rollbackKeyboard() }
  );
}

async function handleCancelEdit(bot, msg) {
  pendingEdits.delete(String(msg.from.id));
  await clearPendingEdit(msg.from.id);
  await reply(bot, msg, `❌ *Edit dibatalkan.*`, { parse_mode: "Markdown" });
}

async function handleDelete(bot, msg, args) {
  const filePath = parseSingleArgument(args, "Format: /delete path/file.js");
  const info = await getProjectFileInfo(getActiveProjectDir(), filePath);
  pendingDeletes.set(String(msg.from.id), {
    projectDir: getActiveProjectDir(),
    filePath: info.relativePath,
    size: info.size,
    modifiedAt: info.modifiedAt,
    createdAt: Date.now()
  });
  await setPendingDelete(msg.from.id, {
    projectDir: getActiveProjectDir(),
    filePath: info.relativePath,
    size: info.size,
    modifiedAt: info.modifiedAt,
    createdAt: Date.now()
  });

  await reply(
    bot,
    msg,
    [
      `⚠️ *CONFIRM DELETE*`,
      `══════════════════`,
      `📄 File: \`${info.relativePath}\``,
      `📊 Size: \`${info.size} bytes\``,
      `🕒 Modified: \`${info.modifiedAt}\``,
      ``,
      `_Tekan /confirmdelete untuk menghapus (backup otomatis), atau /canceldelete untuk batal._`
    ].join("\n"),
    { parse_mode: "Markdown", ...deletePreviewKeyboard() }
  );
}

async function handleConfirmDelete(bot, msg) {
  const key = String(msg.from.id);
  const pending = pendingDeletes.get(key) || (await getPendingDelete(key));
  if (isExpiredPending(pending)) {
    pendingDeletes.delete(key);
    await clearPendingDelete(key);
    await reply(bot, msg, "Tidak ada pending delete aktif atau preview sudah kedaluwarsa.");
    return;
  }

  try {
    await assertPendingDeleteFresh(pending);
  } catch (error) {
    pendingDeletes.delete(key);
    await clearPendingDelete(key);
    await reply(bot, msg, error.message);
    return;
  }

  const result = await deleteProjectFileWithBackup(pending.projectDir, pending.filePath);
  pendingDeletes.delete(key);
  await clearPendingDelete(key);
  await recordBackup({
    projectDir: pending.projectDir,
    filePath: result.relativePath,
    backupPath: result.backup.backupPath,
    action: "delete"
  });
  await recordTask({
    type: "delete",
    projectDir: pending.projectDir,
    filePath: result.relativePath,
    status: "confirmed"
  });
  await recordFileMutation({ projectDir: pending.projectDir, filePath: result.relativePath, action: "delete" });

  await reply(
    bot,
    msg,
    [
      `🗑 *FILE DELETED*`,
      `══════════════════`,
      `📄 File: \`${result.relativePath}\``,
      `📦 Backup: \`${result.backup.backupPath}\``
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleCancelDelete(bot, msg) {
  pendingDeletes.delete(String(msg.from.id));
  await clearPendingDelete(msg.from.id);
  await reply(bot, msg, `❌ *Delete dibatalkan.*`, { parse_mode: "Markdown" });
}

async function handleCreate(bot, msg, args) {
  const { filePath, instruction } = splitPathAndInstruction(args);
  const projectDir = getActiveProjectDir();
  await sendTyping(bot, msg.chat.id);
  const proposal = await proposeNewFile({
    projectDir,
    filePath,
    instruction
  });
  const result = await createProjectFile(projectDir, filePath, proposal.content);
  await recordFileMutation({ projectDir, filePath: result.relativePath, action: "create" });
  await recordTask({
    type: "create",
    projectDir,
    filePath: result.relativePath,
    summary: proposal.summary,
    status: "confirmed"
  });

  await reply(
    bot,
    msg,
    [
      `🆕 *FILE CREATED*`,
      `══════════════════`,
      `📄 File: \`${result.relativePath}\``,
      `📖 Summary: ${proposal.summary}`,
      ``,
      `*Preview:*`,
      createPreview(proposal.content)
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleBackup(bot, msg, args) {
  if (!args) throw new Error("Format: /backup path/file.js");
  const projectDir = getActiveProjectDir();
  const backup = await backupProjectFile(projectDir, args);
  await recordFileOpen({ projectDir, filePath: backup.relativePath });
  await recordBackup({
    projectDir,
    filePath: backup.relativePath,
    backupPath: backup.backupPath,
    action: "manual"
  });
  await reply(bot, msg, [
    `📦 *BACKUP CREATED*`,
    `══════════════════`,
    `📄 File: \`${backup.relativePath}\``,
    `📦 Backup: \`${backup.backupPath}\``
  ].join("\n"), { parse_mode: "Markdown" });
}

async function handleRollback(bot, msg, args = "") {
  const projectDir = getActiveProjectDir();
  const filePath = args.trim() || null;
  const backup = await getLastBackup(projectDir, filePath);
  if (!backup) {
    await reply(bot, msg, filePath ? `Backup untuk ${filePath} tidak ditemukan.` : "Backup terakhir tidak ditemukan.");
    return;
  }

  const result = await restoreProjectFileFromBackup(projectDir, backup.filePath, backup.backupPath);
  await recordFileMutation({ projectDir, filePath: result.relativePath, action: "rollback" });
  await recordTask({
    type: "rollback",
    projectDir,
    filePath: result.relativePath,
    status: "done"
  });

  await reply(
    bot,
    msg,
    [
      `↩️ *ROLLBACK COMPLETE*`,
      `══════════════════`,
      `📄 File: \`${result.relativePath}\``,
      `📦 Restored from: \`${result.restoredFrom}\``
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleSearch(bot, msg, args) {
  if (!args) throw new Error("Format: /search keyword");
  const results = await searchProject(getActiveProjectDir(), args);
  await setLast("search", args);
  await reply(bot, msg, formatSearchResults(results));
}

async function handleMemory(bot, msg, args = "") {
  const trimmed = String(args || "").trim();
  const [sub = "", ...restParts] = trimmed.split(/\s+/);
  const rest = restParts.join(" ").trim();

  if (!trimmed) {
    const summary = await getMemorySummary(getActiveProjectDir());
    await reply(bot, msg, [
      header("Memory", "persistent summary", { icon: "MEM" }),
      summary || "_Belum ada memory persistent._",
      "",
      "*Commands*",
      `${T.bullet} \`/memory add <text>\``,
      `${T.bullet} \`/memory forget <keyword>\``
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "add") {
    if (!rest) throw new Error("Format: /memory add <text>");
    const saved = await savePreference(rest);
    await reply(bot, msg, `Memory disimpan:\n${saved}`);
    return;
  }

  if (sub === "correction") {
    if (!rest) throw new Error("Format: /memory correction <text>");
    const saved = await saveCorrection(rest);
    await reply(bot, msg, `Correction disimpan:\n${saved}`);
    return;
  }

  if (sub === "project") {
    if (!rest) throw new Error("Format: /memory project <fact>");
    const saved = await saveProjectFact(getActiveProjectDir(), rest);
    await reply(bot, msg, `Project fact disimpan:\n${saved}`);
    return;
  }

  if (sub === "env" || sub === "environment") {
    const [key = "", ...valueParts] = restParts;
    const value = valueParts.join(" ").trim();
    if (!key || !value) throw new Error("Format: /memory env <key> <value>");
    const saved = await saveEnvironmentFact(key, value);
    await reply(bot, msg, `Environment fact disimpan: ${saved.key}=${saved.value}`);
    return;
  }

  if (sub === "forget" || sub === "delete") {
    if (!rest) throw new Error("Format: /memory forget <keyword|all>");
    const count = await forgetMemory(rest);
    await reply(bot, msg, `Memory dihapus: ${count} item.`);
    return;
  }

  if (sub === "debug") {
    await reply(bot, msg, await getMemoryForDebug());
    return;
  }

  throw new Error("Subcommand memory tidak dikenal. Pakai /memory, /memory add, atau /memory forget.");
}

async function handleSkills(bot, msg, args = "") {
  const trimmed = String(args || "").trim();
  const [sub = "", ...restParts] = trimmed.split(/\s+/);
  const name = restParts.join(" ").trim();

  if (!trimmed || sub === "list") {
    const skills = await listSkills();
    await reply(bot, msg, [
      header("Skills", `${skills.length} saved`, { icon: "SKILL" }),
      skills.length ? skills.map((skill) => `${T.bullet} \`${skill.name}\` - ${truncateOutput(skill.description || skill.trigger, 100)}`).join("\n") : "_Belum ada skill._",
      "",
      "*Commands*",
      `${T.bullet} \`/skills show <name>\``,
      `${T.bullet} \`/skills delete <name>\``,
      `${T.bullet} \`/skill save <name>\``
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "show") {
    if (!name) throw new Error("Format: /skills show <name>");
    const skill = await getSkill(name);
    await reply(bot, msg, code(formatSkill(skill)));
    return;
  }

  if (sub === "delete" || sub === "del") {
    if (!name) throw new Error("Format: /skills delete <name>");
    const count = await deleteSkill(name);
    await reply(bot, msg, count ? `Skill \`${name}\` dihapus.` : `Skill \`${name}\` tidak ditemukan.`, { parse_mode: "Markdown" });
    return;
  }

  throw new Error("Subcommand skills tidak dikenal. Pakai /skills, /skills show, atau /skills delete.");
}

async function handleSkillSave(bot, msg, args = "") {
  const name = String(args || "").trim();
  if (!name) throw new Error("Format: /skill save <name>");
  const skill = await saveSkillFromLastWorkflow(name);
  await reply(bot, msg, [
    header("Skill saved", skill.name, { icon: "SKILL" }),
    skill.description,
    "",
    `Trigger: \`${skill.trigger}\``
  ].join("\n"), { parse_mode: "Markdown" });
}

async function handleApprovals(bot, msg) {
  const pending = await listPending({ userId: msg.from?.id });
  if (!pending.length) {
    await reply(bot, msg, "Tidak ada approval pending.");
    return;
  }
  const lines = pending.map((ticket) => [
    `ID: \`${ticket.id}\``,
    `Action: \`${ticket.action}\``,
    `Risk: \`${String(ticket.risk || "").toUpperCase()}\``,
    ticket.target ? `Target: \`${ticket.target}\`` : null,
    ticket.expiresAt ? `Expires: \`${new Date(ticket.expiresAt).toISOString()}\`` : null
  ].filter(Boolean).join("\n")).join("\n\n");
  await reply(bot, msg, [
    header("Approvals", `${pending.length} pending`, { icon: "APPROVAL" }),
    lines
  ].join("\n"), { parse_mode: "Markdown" });
}

async function handleHistory(bot, msg) {
  const projectDir = getActiveProjectDir();
  const tasks = await getRecentTasks({ projectDir, maxItems: 20 });
  const projectName = path.basename(projectDir);
  if (!tasks) {
    await reply(bot, msg, [
      header("History", projectName, { icon: "⌖" }),
      "_Belum ada task tercatat._"
    ].join("\n"), { parse_mode: "Markdown", ...remoteCodingKeyboard() });
    return;
  }
  const lines = tasks.split("\n").slice(-15);
  await reply(bot, msg, [
    header("History", `${projectName}  ·  ${lines.length} entries`, { icon: "⌖" }),
    code(truncateOutput(lines.join("\n"), 3000))
  ].join("\n"), { parse_mode: "Markdown", ...remoteCodingKeyboard() });
}

async function handleBriefing(bot, msg) {
  await sendTyping(bot, msg.chat.id);
  const projectDir = getActiveProjectDir();
  const projectName = path.basename(projectDir);
  const live = await liveProgress(bot, msg, [
    header("Briefing", "compiling daily summary...", { icon: "✦" }),
    `_${projectName}_`,
    "",
    `${T.pending}  reading project state...`
  ].join("\n"));

  // Run git status + log + recent tasks in parallel
  const [gitStatus, gitLog, tasks] = await Promise.all([
    runCommand("git status --short --branch", projectDir, { userId: "briefing" }).catch(() => null),
    runCommand("git log --oneline -10", projectDir, { userId: "briefing" }).catch(() => null),
    getRecentTasks({ projectDir, maxItems: 10 }).catch(() => "")
  ]);

  // Parse package.json for hint
  let pkg = null;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8"));
  } catch {}

  const running = listRunningProcesses();
  const now = new Date();
  const dateStr = now.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

  const lines = [
    header("Daily briefing", projectName, { icon: "✦" }),
    `_${dateStr} · ${timeStr}_`,
    "",
    "*Project*",
    kv("name", projectName)
  ];
  if (pkg) {
    lines.push(kv("version", pkg.version || "—"));
    if (pkg.scripts) {
      const scriptNames = Object.keys(pkg.scripts).slice(0, 5);
      lines.push(kv("scripts", scriptNames.join(", ") || "—", { mono: false }));
    }
  }

  // Git
  lines.push("", "*Git*");
  if (gitStatus?.ok) {
    const out = (gitStatus.output || "").trim();
    if (!out) {
      lines.push(`${T.ok}  Working tree clean`);
    } else {
      const statusLines = out.split("\n").slice(0, 8);
      lines.push(code(statusLines.join("\n")));
    }
  } else {
    lines.push(`${T.pending}  Not a git repo`);
  }

  if (gitLog?.ok && gitLog.output?.trim()) {
    lines.push("", "*Recent commits*");
    const commitLines = gitLog.output.trim().split("\n").slice(0, 6);
    lines.push(code(commitLines.join("\n")));
  }

  // Running processes
  lines.push("", "*Runtime*");
  if (running.length === 0) {
    lines.push(`${T.pending}  No active server`);
  } else {
    for (const r of running.slice(0, 3)) {
      lines.push(`${T.ok}  \`${r.label}\`  pid \`${r.pid}\``);
    }
  }

  // Recent agent tasks
  if (tasks) {
    const taskLines = tasks.split("\n").slice(-5);
    lines.push("", "*Recent activity*");
    lines.push(code(taskLines.join("\n")));
  }

  // Crumb
  lines.push(breadcrumb({
    project: projectName,
    engine: `${config.aiProvider}/${config.aiModel}`,
    server: running.length > 0 ? "running" : "idle"
  }));

  const chips = [
    { text: "▶ Run dev", callback_data: "cmd_dev" },
    { text: "⎇ Git status", callback_data: "cmd_git_status" },
    { text: "▣ Tree", callback_data: "cmd_tree" },
    { text: "⌖ History", callback_data: "cmd_history" }
  ];

  await live.finish(lines.join("\n"));
  await reply(bot, msg, "_Quick actions:_", { parse_mode: "Markdown", ...suggestionChips(chips) });
}

// ─── Snippets manager ──────────────────────────────────────────
// Stored in memory.last under key "snippets" as { name: { code, lang, ts } }

async function getSnippets() {
  const data = await getLast("snippets");
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return {};
}

async function saveSnippets(map) {
  await setLast("snippets", map);
}

async function handleSnippet(bot, msg, args) {
  const trimmed = (args || "").trim();
  const subMatch = trimmed.match(/^(save|list|use|del|delete|show)\s*(.*)$/i);
  if (!subMatch) {
    const snippets = await getSnippets();
    const names = Object.keys(snippets);
    await reply(bot, msg, [
      header("Snippets", `${names.length} saved`, { icon: "❍" }),
      "*Cara pakai*",
      `${T.bullet} \`/snippet save <nama>\` — reply ke code block`,
      `${T.bullet} \`/snippet list\` — daftar snippet`,
      `${T.bullet} \`/snippet show <nama>\` — tampilkan`,
      `${T.bullet} \`/snippet use <nama>\` — kirim ulang`,
      `${T.bullet} \`/snippet del <nama>\` — hapus`,
      "",
      names.length > 0 ? `*Saved:* ${names.map((n) => `\`${n}\``).join("  ·  ")}` : "_Belum ada snippet._"
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  const sub = subMatch[1].toLowerCase();
  const rest = subMatch[2].trim();

  if (sub === "list") {
    const snippets = await getSnippets();
    const names = Object.keys(snippets);
    if (names.length === 0) {
      await reply(bot, msg, "_Belum ada snippet tersimpan._", { parse_mode: "Markdown" });
      return;
    }
    const list = names.map((n) => {
      const s = snippets[n];
      const preview = String(s.code || "").split("\n")[0].slice(0, 40);
      return `${T.bullet} \`${n}\`  ${s.lang ? `_${s.lang}_  ` : ""}— \`${preview}\``;
    }).join("\n");
    await reply(bot, msg, [
      header("Snippets", `${names.length} saved`, { icon: "❍" }),
      list
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "save") {
    const name = rest.split(/\s+/)[0];
    if (!name) {
      await reply(bot, msg, "_Format:_ `/snippet save <nama>` _(reply ke pesan code block atau lampirkan code)._", { parse_mode: "Markdown" });
      return;
    }
    let codeText = "";
    let lang = "";
    const reply_msg = msg.reply_to_message;
    if (reply_msg && (reply_msg.text || reply_msg.caption)) {
      const src = reply_msg.text || reply_msg.caption;
      // Extract code block
      const codeMatch = src.match(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/);
      if (codeMatch) {
        lang = codeMatch[1];
        codeText = codeMatch[2].trimEnd();
      } else {
        codeText = src.trimEnd();
      }
    } else {
      // After name, use rest of args as code
      const inline = rest.slice(name.length).trim();
      if (!inline) {
        await reply(bot, msg, "_Reply ke pesan berisi code, atau ketik:_ `/snippet save <nama> <code>`", { parse_mode: "Markdown" });
        return;
      }
      codeText = inline;
    }

    const snippets = await getSnippets();
    snippets[name] = { code: codeText, lang, ts: Date.now() };
    await saveSnippets(snippets);

    await reply(bot, msg, [
      header("Snippet saved", `\`${name}\``, { icon: "✓" }),
      lang ? kv("lang", lang) : "",
      kv("size", `${codeText.length} chars`)
    ].filter(Boolean).join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "show" || sub === "use") {
    const name = rest.split(/\s+/)[0];
    if (!name) {
      await reply(bot, msg, "_Format:_ `/snippet show <nama>`", { parse_mode: "Markdown" });
      return;
    }
    const snippets = await getSnippets();
    const s = snippets[name];
    if (!s) {
      await reply(bot, msg, `_Snippet_ \`${name}\` _tidak ditemukan._`, { parse_mode: "Markdown" });
      return;
    }
    await reply(bot, msg, [
      header(`Snippet  ${name}`, s.lang || "", { icon: "❍" }),
      code(s.code, s.lang || "")
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "del" || sub === "delete") {
    const name = rest.split(/\s+/)[0];
    if (!name) {
      await reply(bot, msg, "_Format:_ `/snippet del <nama>`", { parse_mode: "Markdown" });
      return;
    }
    const snippets = await getSnippets();
    if (!snippets[name]) {
      await reply(bot, msg, `_Snippet_ \`${name}\` _tidak ditemukan._`, { parse_mode: "Markdown" });
      return;
    }
    delete snippets[name];
    await saveSnippets(snippets);
    await reply(bot, msg, `${T.ok}  Snippet \`${name}\` _dihapus._`, { parse_mode: "Markdown" });
    return;
  }
}

async function handleInitAgent(bot, msg) {
  const projectDir = getActiveProjectDir();
  const projectName = path.basename(projectDir);
  const targetPath = path.join(projectDir, "AGENT.md");
  const existing = await fs.readFile(targetPath, "utf8").catch(() => null);

  if (existing) {
    await reply(bot, msg, [
      `📄 *AGENT.md sudah ada*`,
      `══════════════════`,
      `📂 \`${projectName}/AGENT.md\` (${existing.length} chars)`,
      ``,
      `_Edit manual via_ \`/edit AGENT.md ...\` _atau hapus dulu lalu_ \`/initagent\`_._`,
      ``,
      `_Preview:_`,
      "```",
      truncateOutput(existing, 800),
      "```"
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  // Detect framework from package.json
  let framework = "general";
  let language = "JavaScript";
  try {
    const pkgPath = path.join(projectDir, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.next) framework = "Next.js";
    else if (deps["react-native"]) framework = "React Native";
    else if (deps.react) framework = "React";
    else if (deps.vue) framework = "Vue";
    else if (deps.svelte) framework = "Svelte";
    else if (deps.express || deps.fastify) framework = "Node Backend";
    if (deps.typescript) language = "TypeScript";
    if (deps.tailwindcss) framework += " + Tailwind";
  } catch {}

  const template = [
    `# AGENT.md`,
    ``,
    `Custom instructions untuk AI agent (O-W-O) di project _${projectName}_.`,
    ``,
    `## Stack`,
    `- Framework: ${framework}`,
    `- Bahasa: ${language}`,
    `- Package manager: npm`,
    ``,
    `## Conventions`,
    `- Pakai ESM (\`import\`/\`export\`), bukan CommonJS.`,
    `- Indentasi 2 spasi.`,
    `- Naming: camelCase untuk variable & function, PascalCase untuk component.`,
    `- Ekstensi file: \`.js\` / \`.jsx\` (sesuaikan kalau pakai TS).`,
    ``,
    `## Styling`,
    `- ${framework.includes("Tailwind") ? "Pakai utility class Tailwind. Hindari inline style." : "Gunakan CSS module atau styled-components."}`,
    `- Mobile-first, responsive.`,
    ``,
    `## Testing & Build`,
    `- Verify pakai: \`npm run check\` dulu, lalu build/lint/test kalau tersedia.`,
    `- Pastikan no warning sebelum finish.`,
    ``,
    `## Do / Don't`,
    `- ✅ Tulis komentar singkat untuk logic non-trivial.`,
    `- ✅ Validate input di edge.`,
    `- ❌ Jangan tambah dependency baru tanpa konfirmasi.`,
    `- ❌ Jangan modify file di \`node_modules\`, \`dist\`, \`.next\`.`,
    ``,
    `## Catatan project-specific`,
    `_(Tambahkan rules custom di sini, contoh: state management pakai Zustand, API base URL di src/lib/api.js, dll.)_`,
    ``
  ].join("\n");

  await fs.writeFile(targetPath, template, "utf8");

  await reply(bot, msg, [
    `✅ *AGENT.md dibuat*`,
    `══════════════════`,
    `📂 \`${projectName}/AGENT.md\``,
    `🎯 Detected: \`${framework}\` (${language})`,
    ``,
    `_Edit lewat_ \`/edit AGENT.md tambahkan rules ...\``,
    `_Custom rules akan otomatis dipakai saat_ \`/agent\` _atau tool agent dijalankan._`
  ].join("\n"), { parse_mode: "Markdown" });
}

async function handleSyncState(bot, msg) {
  const projectDir = await syncActiveSession();
  if (!projectDir) {
    await reply(bot, msg, "Belum ada project aktif untuk disinkronkan.");
    return;
  }

  const summary = await getMemorySummary(projectDir);
  await reply(
    bot,
    msg,
    [
      `🔄 *STATE SYNCED*`,
      `══════════════════`,
      `📂 Project: \`${projectDir}\``,
      ``,
      summary
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handlePreferences(bot, msg) {
  await reply(bot, msg, await getPreferencesText());
}

async function handleRemember(bot, msg, args) {
  if (!args) throw new Error("Format: /remember preferensi atau catatan");
  const saved = await rememberPreference(args);
  await reply(bot, msg, `🧠 *PREFERENCE SAVED*\n══════════════════\n${saved}`, { parse_mode: "Markdown" });
}

async function handleForget(bot, msg, args) {
  if (!args) throw new Error("Format: /forget keyword atau /forget all");
  const count = await forgetPreference(args);
  await reply(bot, msg, [
    header("Preferences", "cleared", { icon: "✓" }),
    `${T.bullet} Dihapus: \`${count}\` item`
  ].join("\n"), { parse_mode: "Markdown" });
}

async function handlePersona(bot, msg, args) {
  if (!args || !args.trim()) {
    const current = await getLast("persona");
    const display = typeof current === "string" && current.trim()
      ? truncMid(current.trim(), 600)
      : "_(default O-W-O persona)_";
    await reply(bot, msg, [
      header("Persona", "AI character", { icon: "◐" }),
      "",
      "*Aktif*",
      display,
      "",
      "*Cara pakai*",
      `${T.bullet} \`/persona <deskripsi>\` — set persona baru`,
      `${T.bullet} \`/persona reset\` — kembalikan ke default`,
      "",
      "*Contoh*",
      `${T.bullet} \`/persona hacker cyberpunk yang sarkastik\``,
      `${T.bullet} \`/persona pacar manja, panggil aku 'sayang'\``,
      `${T.bullet} \`/persona Stoic philosopher in English\``
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }
  if (/^reset|default|hapus|clear$/i.test(args.trim())) {
    await setLast("persona", "");
    await reply(bot, msg, [
      header("Persona", "reset", { icon: "✓" }),
      "_Kembali ke default O-W-O._"
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }
  const persona = args.trim().slice(0, 2000);
  await setLast("persona", persona);
  await reply(bot, msg, [
    header("Persona", "set", { icon: "✓" }),
    truncMid(persona, 400),
    "",
    `_Coba ngobrol sekarang. Pakai_ \`/persona reset\` _untuk normal._`
  ].join("\n"), { parse_mode: "Markdown" });
}

const chatModeUsers = new Set();

async function handleChatToggle(bot, msg) {
  const userId = String(msg.from?.id);
  if (chatModeUsers.has(userId)) {
    chatModeUsers.delete(userId);
    await reply(bot, msg, [
      header("Chat mode", "off", { icon: "○" }),
      "_Mode normal: intent + agent aktif._"
    ].join("\n"), { parse_mode: "Markdown" });
  } else {
    chatModeUsers.add(userId);
    await reply(bot, msg, [
      header("Chat mode", "on", { icon: "●" }),
      "_Casual chat. Skip intent classifier._",
      `_Pakai_ \`/chat\` _untuk matikan,_ \`/agent\` _untuk coding._`
    ].join("\n"), { parse_mode: "Markdown" });
  }
}

async function handleQuickAsk(bot, msg, args) {
  const question = (args || "").trim();
  if (!question) {
    await reply(bot, msg, [
      header("Quick ask", "fast lane", { icon: "⚡" }),
      `_Forward langsung ke provider tercepat tanpa project context._`,
      "",
      "*Cara pakai*",
      `${T.bullet} \`/quick <pertanyaan>\``,
      `${T.bullet} \`/q <pertanyaan>\` — alias`,
      "",
      "*Contoh*",
      `${T.bullet} \`/q apa ibu kota mongolia?\``,
      `${T.bullet} \`/q konversi 50 USD ke IDR\``
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  // Runtime tetap lewat provider AI aktif (Gemini API / Kiro CLI).
  await sendTyping(bot, msg.chat.id);
  try {
    const agentInstructions = await readAgentInstructions(getActiveProjectDir()).catch(() => "");
    const answer = await chat(
      [
        {
          role: "system",
          content: [
            `Kamu adalah ${config.agentName || "O-W-O"}, Telegram Familiar / Coding Agent.`,
            "Jawab dalam Bahasa Indonesia dengan register aku/kamu.",
            "Jangan pakai emoji, hype opening, atau basa-basi.",
            "Technical terms tetap English.",
            "Jawaban singkat, direct, sharp, dan tetap memuat detail inti.",
            "Ikuti approval boundary, memory policy, skills policy, dan credential rules dari SOUL.md/AGENT.md.",
            `Hari ini: ${new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`,
            agentInstructions ? `\n=== SOUL.md / AGENT.md ===\n${agentInstructions}` : ""
          ].join("\n")
        },
        { role: "user", content: question }
      ]
    );
    await reply(bot, msg, answer);
  } catch (err) {
    await reply(bot, msg, [
      header("AI error", "", { icon: T.fail }),
      `\`${err.message}\``
    ].join("\n"), { parse_mode: "Markdown" });
  }
}

async function handleLogs(bot, msg) {
  await reply(bot, msg, await readCommandLogs());
}

function classifyCommandApprovalAction(command) {
  const text = String(command || "").trim().toLowerCase();
  if (/\bgit\s+push\b/.test(text) && /--force(?:-with-lease)?\b/.test(text)) return "git:push-force";
  if (/\bgit\s+push\b/.test(text)) return "git:push";
  if (/\bgit\s+reset\s+--hard\b/.test(text)) return "git:reset-hard";
  if (/\bgit\s+clean\b/.test(text)) return "git:clean";
  if (/\bnpm\s+publish\b/.test(text)) return "npm:publish";
  if (/\b(?:npm|pnpm|yarn)\s+(?:i|install|add|remove|uninstall)\b/.test(text)) return "npm:install";
  if (/\b(?:vercel|netlify|firebase)\b|\bnpx\s+vercel\b/.test(text)) return "deploy:any";
  if (/\b(?:shutdown|reboot|restart-computer|stop-computer)\b/.test(text)) return "system:shutdown";
  if (/\b(?:get-content|cat|type|more)\b[\s\S]*(?:\.env\b|id_rsa|credentials?|tokens?|cookies?|sessions?|\.pem\b|\.key\b)/.test(text)) return "credential:read";
  return "terminal:command";
}

async function handleRun(bot, msg, args) {
  // If no args provided, display a gorgeous console control menu with quick buttons
  if (!args || !String(args).trim()) {
    const projectDir = getActiveProjectDir();
    const projectName = getActiveProjectName();
    
    // Detect project details and scripts
    const profile = await detectProjectProfile(projectDir);
    const scripts = [];
    try {
      const packageFile = await readProjectFile(projectDir, "package.json", { maxChars: 40000 }).catch(() => null);
      if (packageFile) {
        const pkg = JSON.parse(packageFile.content);
        if (pkg.scripts) {
          Object.keys(pkg.scripts).forEach(name => {
            scripts.push({ name, cmd: `npm run ${name}` });
          });
        }
      }
    } catch (e) {
      // Ignore JSON parse errors
    }

    // Generate inline buttons for custom scripts
    const rows = [];
    
    // Standard commands that are always useful
    const standardButtons = [
      { text: "📦 Install Dependencies", cmd: "npm install" },
      { text: "🧹 Format Prettier", cmd: "npx prettier --write ." },
    ];
    
    // Map common scripts to standard icons
    const getIcon = (name) => {
      if (name.includes("dev") || name.includes("start")) return "▶️";
      if (name.includes("build")) return "🚀";
      if (name.includes("lint")) return "🧹";
      if (name.includes("test")) return "🧪";
      return "⚡";
    };

    const buttonsToDisplay = [];
    
    // Add package.json scripts
    scripts.forEach(script => {
      buttonsToDisplay.push({
        text: `${getIcon(script.name)} ${script.name}`,
        callback_data: `run_cmd_${script.cmd}`
      });
    });
    
    // Add standard buttons if not already present
    standardButtons.forEach(btn => {
      if (!scripts.some(s => s.cmd === btn.cmd)) {
        buttonsToDisplay.push({
          text: btn.text,
          callback_data: `run_cmd_${btn.cmd}`
        });
      }
    });

    // Group buttons into rows of 2
    for (let i = 0; i < buttonsToDisplay.length; i += 2) {
      rows.push(buttonsToDisplay.slice(i, i + 2));
    }

    // Add utility buttons row
    rows.push([
      { text: "⌨️ Custom Command", callback_data: "cmd_terminal" },
      { text: "🎛️ Dashboard", callback_data: "cmd_dashboard" }
    ]);

    const frameworkLabel = profile.framework ? ` [${profile.framework}]` : "";

    const menuUI = [
      `▶️ *RUN COMMAND*`,
      `══════════════════`,
      `📂 \`${projectName}\`${frameworkLabel ? ` · \`${frameworkLabel.trim()}\`` : ``}`,
      ``,
      `_Pilih command atau ketik \`/run [command]\`_`
    ].join("\n");

    await bot.sendMessage(msg.chat.id, menuUI, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows
      }
    });
    return;
  }

  // Otherwise, run the command
  await sendTyping(bot, msg.chat.id);

  // Approval guard: /run / $-alias git push tetap wajib lewat approval ticket.
  const trimmed = String(args || "").trim();
  if (/^git\s+push(\s|$)/i.test(trimmed)) {
    const force = /\s--force(?:-with-lease)?\b/i.test(trimmed);
    const projectDir = getActiveProjectDir();
    const status = await ensureGitRepo(projectDir, { needRemote: true });
    if (!status.ok) {
      await reply(bot, msg, `⚠️ *Push tidak bisa dijalankan*\n${status.reason}`, { parse_mode: "Markdown" });
      return;
    }
    const gh = parseGithubRemote(status.remote);
    const target = gh ? `${gh.owner}/${gh.repo} (branch ${status.branch})` : `${status.remote} (${status.branch})`;
    const ticket = await createApproval({
      service: "git",
      actionId: force ? "git:push-force" : "git:push",
      action: trimmed,
      target,
      payload: { branch: status.branch, remote: status.remote, command: trimmed },
      userId: msg.from?.id,
      chatId: msg.chat.id
    });
    await reply(bot, msg, formatApprovalMessage(ticket), { parse_mode: "Markdown" });
    return;
  }

  const approvalReason = getDestructiveCommandReason(trimmed);
  if (approvalReason) {
    const actionId = classifyCommandApprovalAction(trimmed);
    const ticket = await createApproval({
      service: actionId.split(":")[0] || "terminal",
      actionId,
      action: trimmed,
      target: getActiveProjectPath() || getActiveProjectDir(),
      reason: approvalReason,
      preview: `cwd: ${getActiveProjectDir()}`,
      command: trimmed,
      payload: { command: trimmed },
      userId: msg.from?.id,
      chatId: msg.chat.id
    });
    await reply(bot, msg, formatApprovalMessage(ticket), { parse_mode: "Markdown" });
    return;
  }

  const result = await runCommand(args, getActiveProjectDir(), { userId: msg.from.id });
  await setLast("command", result.command || args);
  if (!result.ok) await setLast("error", result.output);
  else await setLast("error", "");
  await recordTask({
    type: "run",
    projectDir: getActiveProjectDir(),
    command: result.command || args,
    status: result.ok ? "done" : "failed"
  });

  const statusIcon = result.ok ? "🟢" : "🔴";
  const statusText = result.ok ? "SUCCESS" : "FAILED";
  const exitCodeText = result.exitCode !== undefined && result.exitCode !== null ? result.exitCode : "N/A";
  
  // Clean up carriage returns, ANSI codes, and duplicate progress bar lines for elegant view
  const cleanedOutput = cleanTerminalOutput(result.output || "");
  const safeOutput = cleanedOutput
    ? truncateOutput(cleanedOutput, 3000).replace(/```/g, "'''")
    : "";

  let terminalUI;
  let keyboard;
  let publicTunnelLine = "";

  if (!result.ok) {
    keyboard = {
      inline_keyboard: [
        [{ text: "🛠 Benerin Error Ini (AI)", callback_data: `fix_last_error` }]
      ]
    };
  } else if (result.process) {
    const rawDetectedPort = detectDevServerPort(result.output);
    const detectedPort = rawDetectedPort || "3000";

    if (rawDetectedPort) {
      try {
        const tunnel = await openPublicTunnel(rawDetectedPort, msg);
        publicTunnelLine = `Public URL: ${tunnel.url}\nBuka link ini dari HP di luar rumah atau laptop lain.`;
      } catch (error) {
        publicTunnelLine = `Tunnel otomatis gagal: ${error.message}. Jalankan \`/tunnel ${rawDetectedPort}\` untuk coba lagi.`;
      }
    } else {
      publicTunnelLine = `Port dev server belum terdeteksi dari output awal. Klik tombol Expose atau jalankan \`/tunnel 3000\` setelah server siap.`;
    }

    if (publicTunnelLine) {
      await reply(bot, msg, publicTunnelLine, { parse_mode: "Markdown" }).catch(async () => {
        await reply(bot, msg, publicTunnelLine.replace(/\*/g, "").replace(/_/g, "").replace(/`/g, ""));
      });
    }

    keyboard = {
      inline_keyboard: [
        [
          { text: "🛑 Stop Server", callback_data: `cmd_stop` },
          { text: "📋 View Logs", callback_data: `cmd_livelogs` }
        ],
        [
          { text: `🌐 Expose Port ${detectedPort}`, callback_data: `cmd_tunnel_${detectedPort}` }
        ]
      ]
    };
  }

  if (result.ok && result.process) {
    terminalUI = [
      `📡 *DYNAMIC DEV ENVIRONMENT* 🟢`,
      `══════════════════`,
      `📂 *Project:* \`${getActiveProjectName().replace(/`/g, "'")}\``,
      `⚡ *Command:* \`${(result.command || args).replace(/`/g, "'")}\``,
      `🆔 *Label:* \`${result.process.label || "dev-server"}\``,
      `🔌 *PID:* \`${result.process.pid || "N/A"}\``,
      `══════════════════`,
      `> State: 🟢 *ACTIVE & STREAMING LOGS*`,
      ``,
      `*📡 LIVE FEED (INITIALIZE):*`,
      safeOutput ? `\`\`\`powershell\n${safeOutput}\n\`\`\`` : "`[Streaming active, awaiting feed...]`",
      ``,
      `💡 _Process is registered in the background. Choose an action from the deck below:_`
    ].filter(Boolean).join("\n");
  } else {
    terminalUI = [
      `🖥 *EXECUTIVE TERMINAL LOG*`,
      `══════════════════`,
      `📂 *Project:* \`${getActiveProjectName().replace(/`/g, "'")}\``,
      `⌨️ *Command:* \`${(result.command || args).replace(/`/g, "'")}\``,
      `📊 *Status:* ${statusIcon} *${statusText}* (Code: ${exitCodeText})`,
      `══════════════════`,
      ``,
      `*📡 OUTPUT BUFFER:*`,
      safeOutput ? `\`\`\`powershell\n${safeOutput}\n\`\`\`` : "`[Empty Output Buffer]`",
      ``,
      summarizeCommandResult(result)
    ].filter(Boolean).join("\n");
  }

  try {
    await bot.sendMessage(msg.chat.id, terminalUI, { 
      parse_mode: "Markdown",
      reply_markup: keyboard
    });
  } catch (error) {
    await logger.warn("Gagal mengirim terminal UI dengan Markdown, mencoba plain text", { error: error.message });
    // Strip formatting to prevent any potential parse crashes
    const plainUI = terminalUI
      .replace(/\*/g, "")
      .replace(/_/g, "")
      .replace(/`/g, "");
    await bot.sendMessage(msg.chat.id, plainUI, {
      reply_markup: keyboard
    }).catch((err) => {
      logger.error("Gagal total mengirim terminal UI", { error: err.message });
    });
  }
}

async function handleStop(bot, msg, args) {
  if (args === "all") {
    const results = await stopAllProcesses();
    closePublicTunnels();
    await reply(bot, msg, results.length ? results.map((result) => result.message).join("\n") : "Tidak ada process berjalan.");
    return;
  }

  const result = await stopProcess(args || "dev-server");
  if (result.stopped) closePublicTunnels();
  await reply(bot, msg, result.message);
}

async function handleRestart(bot, msg) {
  await sendTyping(bot, msg.chat.id);
  closePublicTunnels();
  const result = await restartDevServer(getActiveProjectDir());
  await reply(bot, msg, [result.ok ? "Dev server restart diproses." : "Restart gagal.", "", result.output].join("\n"));
}

async function handleNaturalConfirmCancel(bot, msg, text) {
  if (!isAffirmative(text) && !isNegative(text)) return false;

  const key = String(msg.from.id);
  const pendingEdit = pendingEdits.get(key) || (await getPendingEdit(key));
  const pendingDelete = pendingDeletes.get(key) || (await getPendingDelete(key));

  if (!pendingEdit && !pendingDelete) return false;

  if (isNegative(text)) {
    if (pendingEdit) await handleCancelEdit(bot, msg);
    if (pendingDelete) await handleCancelDelete(bot, msg);
    return true;
  }

  if (pendingEdit) {
    await handleConfirmEdit(bot, msg);
    return true;
  }

  if (pendingDelete) {
    await handleConfirmDelete(bot, msg);
    return true;
  }

  return false;
}

async function handleNaturalDirect(bot, msg, text) {
  const value = normalizeNatural(text);
  const lowered = value.toLowerCase();

  if (await handleNaturalConfirmCancel(bot, msg, value)) return true;

  // ── HELP & ABOUT ──
  if (/^(kamu bisa apa|bisa apa|help|bantuan|cara pakai|apa saja yang bisa kamu lakukan|panduan|tutorial|guide|ajarkan cara pakai|fitur kamu apa|siapa kamu|lu siapa|identity|identitas)\??$/i.test(value)) {
    await bot.sendMessage(msg.chat.id, helpTextV2(), { parse_mode: "Markdown", ...getMainMenuKeyboard(listRunningProcesses().length) });
    return true;
  }

  if (/^(remote laptop|kontrol laptop|menu laptop|kendali laptop|control laptop|buka remote laptop|command laptop|laptop remote|\/laptop)$/i.test(value)) {
    await handleRemoteLaptop(bot, msg);
    return true;
  }

  if (/^(remote coding|menu coding|coding dari hp|coding lewat telegram|coding remote|terminal coding|console coding|\/coding)$/i.test(value)) {
    await handleRemoteCodingMenu(bot, msg);
    return true;
  }

  if (/^(aplikasi aktif|list aplikasi aktif|lihat aplikasi aktif|daftar aplikasi aktif|app aktif|proses aplikasi aktif)$/i.test(value)) {
    await handleActiveDesktopApps(bot, msg);
    return true;
  }

  if (/^(buka aplikasi|list aplikasi|daftar aplikasi|aplikasi laptop|open app|open apps)$/i.test(value)) {
    await handleLaunchableDesktopApps(bot, msg);
    return true;
  }

  // ── NATURAL: SPOTIFY PLAY SONG ──
  let songQuery = null;
  const spotifyMatch = value.match(/(?:putar|play|dengarkan)\s+(?:lagu\s+)?(.+?)\s*(?:di|on)?\s*spotify/i) || 
                       value.match(/spotify\s*(?:putar|play|dengarkan)\s+(?:lagu\s+)?(.+)/i);
  
  if (spotifyMatch) {
    songQuery = spotifyMatch[1].trim();
  } else {
    // General play fallback to Spotify
    const generalPlayMatch = value.match(/^(?:putar|play|dengarkan)\s+(?:lagu\s+)?(.+)/i);
    if (generalPlayMatch) {
      songQuery = generalPlayMatch[1].trim();
    }
  }
  
  if (songQuery && !/^(aplikasi|app|spotify|browser|chrome|youtube)$/i.test(songQuery)) {
    await reply(bot, msg, `🎵 _Membuka Spotify dan memutar:_ \`${songQuery}\`_..._`, { parse_mode: "Markdown" });
    
    const cleanSongQuery = songQuery.replace(/"/g, '`"').replace(/\$/g, '`$');
    const playScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@

# Force close any existing Spotify instances to ensure a completely clean slate
Stop-Process -Name Spotify -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# Launch a completely fresh Spotify instance using the global protocol
Start-Process "spotify:"

# Wait for the new Spotify window to appear and get its handle (up to 12 seconds)
$proc = $null
for ($i = 0; $i -lt 24; $i++) {
    $proc = Get-Process -Name "Spotify" -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
    if ($proc) { break }
    Start-Sleep -Milliseconds 500
}

if ($proc) {
    if ([WinApi]::IsIconic($proc.MainWindowHandle)) {
        [WinApi]::ShowWindow($proc.MainWindowHandle, 9)
    } else {
        [WinApi]::ShowWindow($proc.MainWindowHandle, 5)
    }
    [WinApi]::SetForegroundWindow($proc.MainWindowHandle)
} else {
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.AppActivate("Spotify")
}

Start-Sleep -Milliseconds 600
$wshell = New-Object -ComObject WScript.Shell

# Force focus to Search Input box using Ctrl + L
$wshell.SendKeys('^l')
Start-Sleep -Milliseconds 250

# Clear old search text: Send Ctrl + A, then Backspace
$wshell.SendKeys('^a')
Start-Sleep -Milliseconds 150
$wshell.SendKeys('{BACKSPACE}')
Start-Sleep -Milliseconds 150

# Type the new search query safely
$songQuery = "${cleanSongQuery}"
$escapedQuery = ""
foreach ($char in $songQuery.ToCharArray()) {
    $c = [string]$char
    if ("+^%~(){}".Contains($c)) {
        $escapedQuery += "{$c}"
    } else {
        $escapedQuery += $c
    }
}
$wshell.SendKeys($escapedQuery)
Start-Sleep -Milliseconds 300

# Press Enter to force Spotify to search
$wshell.SendKeys('{ENTER}')
Start-Sleep -Milliseconds 800

# Press Down Arrow twice to focus the Top Result card and Enter to play!
$wshell.SendKeys('{DOWN}')
Start-Sleep -Milliseconds 200
$wshell.SendKeys('{DOWN}')
Start-Sleep -Milliseconds 200
$wshell.SendKeys('{ENTER}')
`;
      
      const openResult = await runPowerShell(playScript);
      if (openResult.ok) {
        await reply(bot, msg, `✅ *SPOTIFY PLAYING*\n══════════════════\n🎵 Memutar: \`${songQuery}\`\n\n_Gunakan tombol di bawah untuk kontrol pemutaran._`, { parse_mode: "Markdown", ...mediaControlKeyboard() });
      } else {
        await reply(bot, msg, `❌ *Gagal memutar di Spotify*\n${openResult.output}`);
      }
      return true;
    }

  // ── NATURAL: SITE-SPECIFIC OR BROWSER SEARCH ──
  let targetBrowser = null;
  let browserSearchSite = null;
  let browserSearchQuery = null;
  let siteMatch = false;

  // 1. Detect if a specific browser is mentioned in the entire text
  const browserList = ["brave", "chrome", "edge", "msedge", "firefox", "opera", "vivaldi", "safari"];
  for (const b of browserList) {
    if (new RegExp(`\\b${b}\\b`, "i").test(value)) {
      targetBrowser = b;
      break;
    }
  }

  // 2. Pattern 1: Buka [browser] dan cari [query] di [site]
  // E.g., "buka brave dan cari lagu XXL - lany di spotify.com"
  // E.g., "buka chrome lalu cari belajar node.js di google"
  const pattern1 = value.match(/^(?:buka|open)\s+(brave|chrome|edge|msedge|firefox|opera|vivaldi|safari|browser)\s+(?:dan|lalu|terus|kemudian)?\s*(?:cari|search|putar|play|dengarkan)\s+(?:lagu\s+|video\s+|informasi\s+tentang\s+|tentang\s+)?(.+?)\s+di\s+([a-zA-Z0-9.-]+)(?:\.[a-zA-Z]{2,})?$/i);

  // Pattern 2: Buka [browser] dan cari [query]
  // E.g., "buka brave dan cari lagu XXL - lany" (Generic Google search inside a specific browser)
  const pattern2 = value.match(/^(?:buka|open)\s+(brave|chrome|edge|msedge|firefox|opera|vivaldi|safari|browser)\s+(?:dan|lalu|terus|kemudian)?\s*(?:cari|search|google|browsing)\s+(?:lagu\s+|video\s+|informasi\s+tentang\s+|tentang\s+)?(.+)$/i);

  // Pattern 3: Cari [query] di [site] pake [browser]
  // E.g., "cari lagu XXL - lany di spotify.com pake brave"
  const pattern3 = value.match(/^(?:cari|search|putar|play|dengarkan)\s+(?:lagu\s+|video\s+|informasi\s+tentang\s+|tentang\s+)?(.+?)\s+di\s+([a-zA-Z0-9.-]+)(?:\.[a-zA-Z]{2,})?\s+(?:pake|menggunakan|lewat|di|dengan)\s+(brave|chrome|edge|msedge|firefox|opera|vivaldi|safari|browser)$/i);

  // Pattern 4: Cari [query] di [site] (General site search)
  // E.g., "cari lagu XXL - lany di spotify.com"
  const pattern4 = value.match(/^(?:cari|search|putar|play|dengarkan)\s+(?:lagu\s+|video\s+|informasi\s+tentang\s+|tentang\s+)?(.+?)\s+di\s+([a-zA-Z0-9.-]+)(?:\.[a-zA-Z]{2,})?$/i);

  // Pattern 5: Buka [site] lalu cari [query]
  // E.g., "buka youtube.com terus cari tutorial"
  const pattern5 = value.match(/^(?:buka|open)\s+([a-zA-Z0-9.-]+)(?:\.[a-zA-Z]{2,})?\s+(?:dan|terus|lalu|kemudian)?\s*(?:cari|search|putar|play|dengarkan)\s+(.+)$/i);

  // Pattern 6: [site] search [query]
  // E.g., "youtube cari lagu baru"
  const pattern6 = value.match(/^([a-zA-Z0-9.-]+)(?:\.[a-zA-Z]{2,})?\s+(?:search|cari|putar|play)\s+(.+)$/i);

  // Pattern 7: Buka browser dan cari [query]
  // E.g., "buka google dan cari lagu XXL - lany"
  const pattern7 = value.match(/^(?:buka\s+browser\s+dan\s+cari|buka\s+google\s+dan\s+cari|buka\s+browser\s+lalu\s+cari)\s+(.+)$/i);

  // Pattern 8: Generic "cari [query]" without specific site
  // E.g., "cari informasi tentang gemini ai"
  const pattern8 = value.match(/^(?:cari|search|google|browsing|searching|temukan)\s+(?:informasi\s+tentang\s+|tentang\s+|di\s+internet\s+tentang\s+|di\s+google\s+tentang\s+)?(.+?)(?:\s+di\s+(?:google|browser|internet|chrome|firefox|edge|safari))?$/i);

  if (pattern1) {
    targetBrowser = pattern1[1].toLowerCase() === "browser" ? null : pattern1[1];
    browserSearchQuery = pattern1[2].trim();
    browserSearchSite = pattern1[3].trim();
    siteMatch = true;
  } else if (pattern3) {
    browserSearchQuery = pattern3[1].trim();
    browserSearchSite = pattern3[2].trim();
    targetBrowser = pattern3[3].toLowerCase() === "browser" ? null : pattern3[3];
    siteMatch = true;
  } else if (pattern2) {
    targetBrowser = pattern2[1].toLowerCase() === "browser" ? null : pattern2[1];
    browserSearchQuery = pattern2[2].trim();
    browserSearchSite = "google";
    siteMatch = true;
  } else if (pattern4) {
    browserSearchQuery = pattern4[1].trim();
    browserSearchSite = pattern4[2].trim();
    siteMatch = true;
  } else if (pattern5) {
    browserSearchSite = pattern5[1].trim();
    browserSearchQuery = pattern5[2].trim();
    siteMatch = true;
  } else if (pattern6) {
    // Make sure browserSearchSite is not a browser name to avoid conflict
    const testSite = pattern6[1].toLowerCase();
    if (!browserList.includes(testSite) && testSite !== "browser" && testSite !== "aplikasi" && testSite !== "app") {
      browserSearchSite = pattern6[1].trim();
      browserSearchQuery = pattern6[2].trim();
      siteMatch = true;
    }
  } else if (pattern7) {
    browserSearchQuery = pattern7[1].trim();
    browserSearchSite = "google";
    siteMatch = true;
  } else if (pattern8) {
    const fallbackQuery = pattern8[1].trim();
    if (fallbackQuery && !/^(chrome|firefox|edge|browser|google|safari|opera|vivaldi|brave)$/i.test(fallbackQuery)) {
      browserSearchQuery = fallbackQuery;
      browserSearchSite = "google";
      siteMatch = true;
    }
  }

  if (siteMatch && browserSearchQuery) {
    const siteKey = browserSearchSite.toLowerCase().replace(/\.(com|org|net|id|co\.id|me)$/i, "");
    const browserLabel = targetBrowser ? targetBrowser.charAt(0).toUpperCase() + targetBrowser.slice(1) : "Default Browser";

    // ── Media sites (spotify/youtube): auto-play via mouse automation ──
    if (siteKey === "spotify" || siteKey === "youtube") {
      const label = siteKey === "spotify" ? "Spotify Web 🎵" : "YouTube 🎥";
      await reply(bot, msg, `🎶 _Membuka ${label} dan memutar:_ \`${browserSearchQuery}\` _..._\n⏳ _Tunggu beberapa detik..._`, { parse_mode: "Markdown" });
      const playResult = await playSearchInBrowser(siteKey, browserSearchQuery);
      if (playResult.ok) {
        await reply(bot, msg, [
          `✅ *NOW PLAYING*`,
          `══════════════════`,
          `🎯 *Situs:* \`${playResult.siteLabel}\``,
          `🔍 *Pencarian:* \`${browserSearchQuery}\``,
          `💻 *Browser:* \`${browserLabel}\``,
          `══════════════════`,
          `▶️ _Lagu/video sedang diputar di browser laptopmu!_`,
          `🎛 _Gunakan tombol di bawah untuk kontrol pemutaran._`
        ].join("\n"), { parse_mode: "Markdown", ...mediaControlKeyboard() });
      } else {
        await reply(bot, msg, `❌ *Gagal memutar di ${label}*\n${playResult.output}`);
      }
      return true;
    }

    // ── Non-media sites: just open the search URL ──
    let searchUrl = "";
    let siteLabel = "";
    switch (siteKey) {
      case "github":
        searchUrl = `https://github.com/search?q=${encodeURIComponent(browserSearchQuery)}`;
        siteLabel = "GitHub 🐙";
        break;
      case "wikipedia":
        searchUrl = `https://id.wikipedia.org/w/index.php?search=${encodeURIComponent(browserSearchQuery)}`;
        siteLabel = "Wikipedia 📖";
        break;
      case "google":
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(browserSearchQuery)}`;
        siteLabel = "Google 🌐";
        break;
      default:
        if (browserSearchSite.includes(".")) {
          searchUrl = `https://${browserSearchSite}/search?q=${encodeURIComponent(browserSearchQuery)}`;
          siteLabel = `${browserSearchSite} 🌐`;
        } else {
          searchUrl = `https://www.google.com/search?q=site:${browserSearchSite}+${encodeURIComponent(browserSearchQuery)}`;
          siteLabel = `${browserSearchSite}.com 🌐`;
        }
        break;
    }

    await reply(bot, msg, `🔍 _Membuka ${siteLabel}:_ \`${browserSearchQuery}\` _menggunakan_ \`${browserLabel}\`_..._`, { parse_mode: "Markdown" });
    const searchResult = await openUrl(searchUrl, targetBrowser);
    if (searchResult.ok) {
      await reply(bot, msg, [
        `✅ *SEARCH COMPLETED*`,
        `══════════════════`,
        `🎯 *Situs:* \`${siteLabel}\``,
        `🔍 *Pencarian:* \`${browserSearchQuery}\``,
        `💻 *Browser:* \`${browserLabel}\``,
        `══════════════════`,
        ` _Pencarian telah berhasil dibuka di laptopmu._`
      ].join("\n"), { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
    } else {
      await reply(bot, msg, `❌ *Gagal membuka ${siteLabel} menggunakan ${browserLabel}*\n${searchResult.output}`);
    }
    return true;
  }

  // ── NATURAL: BUKA APLIKASI SPESIFIK ──
  const openAppMatch = value.match(/^(?:buka|open|jalankan|launch|nyalain|nyalakan|run|start)\s+(?:aplikasi\s+)?(.+)$/i);
  if (openAppMatch) {
    const appQuery = openAppMatch[1].trim().toLowerCase();
    // Skip if it looks like a project/coding command
    if (!/^(terminal|cmd|powershell|coding|laptop|project|workspace|server|dev)$/i.test(appQuery)) {
      const result = await listLaunchableApps({ limit: 50 });
      if (result.ok && result.apps.length) {
        const match = result.apps.find(app =>
          app.name.toLowerCase().includes(appQuery) ||
          appQuery.includes(app.name.toLowerCase())
        );
        if (match) {
          // Check if there's a URL after the app name
          const afterApp = appQuery.replace(match.name.toLowerCase(), "").trim();
          const urlMatch = afterApp.match(/^(https?:\/\/\S+|\S+\.\S+)/i);

          if (isBrowserApp(match.name) && urlMatch) {
            // Browser + URL → open URL in that browser
            const url = urlMatch[1];
            await reply(bot, msg, `🌐 _Membuka_ \`${url}\` _di_ \`${match.name}\`_..._`, { parse_mode: "Markdown" });
            const urlResult = await openUrl(url, match.name);
            await reply(bot, msg, urlResult.ok
              ? [`✅ *URL OPENED*`, `══════════════════`, `🌐 \`${urlResult.detail?.url || url}\``, `💻 \`${match.name}\``].join("\n")
              : `❌ *Gagal membuka URL*\n${urlResult.output}`,
              { parse_mode: "Markdown" });
            return true;
          }

          // Normal app launch
          await reply(bot, msg, `🚀 _Membuka_ \`${match.name}\`_..._`, { parse_mode: "Markdown" });
          const openResult = await openDesktopApp(match.path);
          if (openResult.ok) {
            const postRows = [];
            if (isBrowserApp(match.name)) {
              postRows.push([{ text: "🌐 Buka URL", callback_data: `browser_url_${encodeURIComponent(match.name).slice(0, 30)}` }]);
            }
            postRows.push([
              { text: "📸 Screenshot", callback_data: "desktop_screenshot" },
              { text: "📊 List Apps", callback_data: "desktop_active_apps" }
            ]);
            postRows.push([{ text: "◀️ Menu", callback_data: "cmd_main_menu" }]);
            await reply(bot, msg, [
              `✅ *APP LAUNCHED*`,
              `══════════════════`,
              `💻 \`${match.name}\``,
              ``,
              isBrowserApp(match.name) ? `_Ketik URL atau tekan Buka URL._` : `_Aplikasi berhasil dibuka._`
            ].join("\n"), { parse_mode: "Markdown", ...actionKeyboard(postRows) });
          } else {
            await reply(bot, msg, `❌ *Gagal membuka* \`${match.name}\`\n${openResult.output}`, { parse_mode: "Markdown" });
          }
          return true;
        }
        // Tidak ditemukan, tampilkan saran
        const suggestions = result.apps
          .filter(app => app.name.toLowerCase().includes(appQuery.slice(0, 3)))
          .slice(0, 5);
        if (suggestions.length) {
          const rows = suggestions.map(app => [{
            text: `🚀 ${app.name}`,
            callback_data: createDesktopAppCallback("open", { name: app.name, path: app.path })
          }]);
          rows.push([{ text: "📋 Semua Aplikasi", callback_data: "desktop_open_apps" }]);
          rows.push([{ text: "◀️ Menu", callback_data: "cmd_main_menu" }]);
          await reply(bot, msg, [
            `🔍 *APP SEARCH*`,
            `══════════════════`,
            `🎯 Query: \`${openAppMatch[1]}\``,
            ``,
            `_Tidak ditemukan persis. Mungkin maksud kamu:_`
          ].join("\n"), { parse_mode: "Markdown", ...actionKeyboard(rows) });
          return true;
        }
      }
    }
  }

  // ── NATURAL: TUTUP APLIKASI SPESIFIK ──
  const closeAppMatch = value.match(/^(?:tutup|close|matikan|kill|matiin|hentikan|stop|exit)\s+(?:aplikasi\s+)?(.+)$/i);
  if (closeAppMatch) {
    const appQuery = closeAppMatch[1].trim().toLowerCase();
    // Skip system/coding terms
    if (!/^(terminal|cmd|powershell|coding|laptop|project|workspace|server|dev|pc|all|semua)$/i.test(appQuery)) {
      const result = await listActiveDesktopApps({ limit: 30 });
      if (result.ok && result.apps.length) {
        const match = result.apps.find(app =>
          (app.name || "").toLowerCase().includes(appQuery) ||
          (app.title || "").toLowerCase().includes(appQuery)
        );
        if (match) {
          if (await isSafeModeEnabled()) {
            await reply(bot, msg, [
              `⚠️ *CONFIRM CLOSE*`,
              `══════════════════`,
              `💻 App: \`${match.name}\``,
              `🆔 PID: \`${match.pid}\``,
              match.title ? `📝 Title: \`${match.title}\`` : null,
              ``,
              `_Tekan konfirmasi untuk menutup._`
            ].filter(Boolean).join("\n"), {
              parse_mode: "Markdown",
              ...actionKeyboard([
                [{ text: `Ya, tutup ${match.name}`, callback_data: createDesktopAppCallback("confirmclose", match) }],
                [{ text: "Batal", callback_data: "cmd_remote_laptop" }]
              ])
            });
          } else {
            await reply(bot, msg, `🚫 _Menutup_ \`${match.name}\` _[PID ${match.pid}]..._`, { parse_mode: "Markdown" });
            const closeResult = await closeDesktopApp(match.pid);
            const detail = closeResult.detail || {};
            await reply(bot, msg, closeResult.ok
              ? `✅ *\`${match.name}\` berhasil ditutup.* Status: \`${detail.status || "closed"}\``
              : `❌ *Gagal menutup* \`${match.name}\`\n${closeResult.output}`,
              { parse_mode: "Markdown" });
          }
          return true;
        }
      }
    }
  }

  // ── NATURAL: SCREENSHOT ──
  if (/^(screenshot|tangkap layar|ss|screenshoot|ambil screenshot|foto layar|foto laptop|capture screen|ss laptop|screenshot laptop)$/i.test(value)) {
    await handleLaptopScreenshot(bot, msg);
    return true;
  }

  // ── NATURAL: BUKA URL ──
  const urlCmdMatch = value.match(/^(?:buka|open)\s+(?:url|link|website|situs|web)\s+(.+)$/i);
  if (urlCmdMatch) {
    const url = urlCmdMatch[1].trim();
    await reply(bot, msg, `🌐 _Membuka_ \`${url}\`_..._`, { parse_mode: "Markdown" });
    const urlResult = await openUrl(url);
    await reply(bot, msg, urlResult.ok
      ? [`✅ *URL OPENED*`, `══════════════════`, `🌐 \`${urlResult.detail?.url || url}\``].join("\n")
      : `❌ *Gagal membuka URL*\n${urlResult.output}`,
      { parse_mode: "Markdown" });
    return true;
  }

  // ── MEMORY & PREFERENCES ──
  if (/^(apa yang kamu ingat|memory kamu apa|lihat memory|preferensi apa|cek ingatan|apa yang kamu tahu tentang aku|lihat settingan aku|kamu ingat apa|apa saja preferensi aku)$/i.test(value)) {
    await handlePreferences(bot, msg);
    return true;
  }

  if (/^(sync|sinkron|sinkronkan|refresh state|refresh memory|bersihkan state|reset state lama)$/i.test(value)) {
    await handleSyncState(bot, msg);
    return true;
  }

  const rememberText = extractAfter(value, [
    /^(?:ingat|remember|catat|tolong ingat|simpan|hafalkan)\s+(.+)$/i,
    /^(?:tolong ingat|tolong catat|tolong hafalkan)\s+(.+)$/i
  ]);
  if (rememberText && !/\bskill\b/i.test(value)) {
    await handleRemember(bot, msg, rememberText);
    return true;
  }

  const forgetText = extractAfter(value, [
    /^(?:lupakan|forget|hapus ingatan|hapus memory|reset memory)\s+(.+)$/i,
    /^(?:hapus memory tentang|lupakan tentang|buang ingatan tentang)\s+(.+)$/i
  ]);
  if (forgetText) {
    await handleForget(bot, msg, forgetText);
    return true;
  }

  // ── WORKSPACE & PROJECTS ──
  const skillSaveText = extractAfter(value, [
    /^(?:simpan|save)\s+(?:workflow|alur|prosedur)\s+(.+?)\s+sebagai\s+skill$/i,
    /^(?:simpan|save)\s+workflow\s+(.+)$/i,
    /^(?:simpan|save)\s+(.+?)\s+sebagai\s+skill$/i
  ]);
  if (skillSaveText) {
    const name = skillSaveText.replace(/^(?:debugging|ini)\s*/i, "").trim() || "workflow-terakhir";
    await handleSkillSave(bot, msg, name);
    return true;
  }

  const workspacePath = extractAfter(value, [
    /^(?:buka|set|ganti|pindah(?:kan)?|masuk ke|akses|pindah ke)\s+workspace\s+(.+)$/i,
    /^(?:workspace|folder utama|lokasi kerja)\s+(.+)$/i
  ]);
  if (workspacePath) {
    await handleSetWorkspace(bot, msg, workspacePath);
    return true;
  }

  if (/^(?:lihat\s+|buka\s+|tampilkan\s+)?(?:semua\s+)?(?:daftar\s+|list\s+)?projects?$|^project apa saja$|^tampilkan semua project$|^ada project apa saja$|^list project$|^tunjukin project$|^buka semua list project$/i.test(value)) {
    await handleProjects(bot, msg);
    return true;
  }

  const projectName = extractAfter(value, [
    /^(?:pindah|switch|buka|ganti|masuk|akses|open|jalankan)\s+(?:ke\s+)?project\s+(.+)$/i,
    /^(?:pindah|switch|buka|ganti|masuk|akses|open|jalankan)\s+ke\s+(.+)$/i,
    /^(?:buka|open|masuk)\s+(.+)$/i
  ]);
  if (projectName && !/[\\/]/.test(projectName) && !/\.(js|ts|jsx|tsx|css|html|json|md)$/i.test(projectName)) {
    await handleSwitch(bot, msg, projectName);
    await handleTree(bot, msg);
    return true;
  }

  // ── SYSTEM MONITORING ──
  if (/^(status|cek status|dashboard|kondisi bot|gimana kondisi|info sistem|sistem info|apa kabar|aman gak|kondisi saat ini|lagi apa)$/i.test(value)) {
    await handleDashboard(bot, msg);
    return true;
  }

  if (/^(health|cek health|sehat|sehat gak|kondisi pc|cek kondisi laptop|cek ram cpu|cek beban pc|laptop aman|spek laptop|informasi hardware)$/i.test(value)) {
    await handleHealth(bot, msg);
    return true;
  }

  if (/^(logs?|lihat log|cek log|log terakhir|tampilkan log|ada error apa|cek error|apa yang terjadi|tampilkan error|log nya mana|lihat kejadian)$/i.test(value)) {
    await handleLogs(bot, msg);
    return true;
  }

  // ── PC CONTROL ──
  if (/^(kunci pc|lock screen|kunci layar|kunci laptop|tutup windows|lock pc|kunciin pc|kunciin laptop)$/i.test(value)) {
    await handlePCControl(bot, msg, "lock");
    return true;
  }

  if (/^(shutdown|matikan pc|matikan laptop|power off|mati pc|matiin pc|matiin laptop|matikan komputer|off pc)$/i.test(value)) {
    await handlePCControl(bot, msg, "shutdown");
    return true;
  }

  if (/^(restart pc|restart laptop|reboot|mulai ulang pc|mulai ulang laptop|reset pc)$/i.test(value)) {
    await handlePCControl(bot, msg, "restart");
    return true;
  }

  if (/^(buka terminal|open terminal|buka cmd|open cmd|buka powershell|pop terminal|munculkan terminal)$/i.test(value)) {
    await handlePCControl(bot, msg, "openterminal");
    return true;
  }

  // ── PROCESS MANAGEMENT ──
  if (/^(stop dev server|stop server|matikan server|stop semua|stop all|matikan proses|hentikan server|tutup server|kill server|matiin server|stop dlu)$/i.test(value)) {
    await handleStop(bot, msg, lowered.includes("semua") || lowered.includes("all") ? "all" : "dev-server");
    return true;
  }

  if (/^(restart dev server|restart server|ulang server|nyalakan ulang server|reset server|ulangin server|nyalain lagi server)$/i.test(value)) {
    await handleRestart(bot, msg);
    return true;
  }

  // ── DEV OPERATIONS ──
  if (/^(jalankan dev server|run dev|dev server|start dev|nyalakan dev|mulai dev|jalankan server|npm dev|nyalain dev|run server)$/i.test(value)) {
    await handleRun(bot, msg, "npm run dev");
    return true;
  }

  if (/^(cek build|run build|build|jalankan build|kompilasi|buat production|rakit project|production build)$/i.test(value)) {
    await handleRun(bot, msg, "npm run build");
    return true;
  }

  if (/^(cek lint|run lint|lint|cek penulisan|periksa kode|format kode|rapikan kode|bersihkan kode)$/i.test(value)) {
    await handleRun(bot, msg, "npm run lint");
    return true;
  }

  if (/^(cek test|run test|test|jalankan test|periksa fitur|uji coba|testing)$/i.test(value)) {
    await handleRun(bot, msg, "npm run test");
    return true;
  }

  // ── GIT OPERATIONS ──
  if (/^(cek git|git status|status git|periksa git|kondisi repo|cek perubahan|ada update apa|git nya gimana)$/i.test(value)) {
    await handleRun(bot, msg, "git status");
    return true;
  }

  if (/^(lihat diff|git diff|diff|lihat perubahan|cek bedanya|apa yang berubah|tunjukin perubahan)$/i.test(value)) {
    await handleRun(bot, msg, "git diff");
    return true;
  }

  const commitMatch = value.match(/^(?:commit|git commit|simpan perubahan|catat perubahan|bungkus kode)(?:\s+(?:dengan pesan)?\s+)?(.+)$/i);
  if (commitMatch) {
    await handleRun(bot, msg, "git add .");
    await handleRun(bot, msg, `git commit -m "${commitMatch[1].replace(/"/g, "'").trim()}"`);
    return true;
  }

  if (/^(push|git push|push ke origin|push ke remote|unggah kode|kirim ke github|upload kode|kirim kode)$/i.test(value)) {
    await handlePush(bot, msg);
    return true;
  }

  if (/^(pull|git pull|tarik|tarik perubahan|ambil update|update kode dari git|ambil data baru)$/i.test(value)) {
    await handleRun(bot, msg, "git pull");
    return true;
  }

  // ── PACKAGE MANAGEMENT ──
  const installMatch = value.match(/^(?:install|pasang|tambah(?:kan)?|tambah library|tambah paket|install library)\s+(.+)$/i);
  if (installMatch) {
    const packages = installMatch[1].trim();
    if (!/[\\/]/.test(packages)) {
      await handleRun(bot, msg, `npm install ${packages}`);
      return true;
    }
  }

  if (/^(npm install|npm i|install dependencies|pasang dependencies|install semua|pasang semua library)$/i.test(value)) {
    await handleRun(bot, msg, "npm install");
    return true;
  }

  // ── FILE OPERATIONS ──
  if (/^(tree|lihat struktur|struktur project|folder project|lihat folder|tampilkan folder|tampilkan struktur|tampilkan seluruh struktur|lihat seluruh folder|lihat seluruh struktur|struktur folder|lihat tree|tampilkan tree|tampilkan semua folder|lihat isi project|isi project|lihat isi folder|daftar file|ada file apa saja|tunjukkan folder)$/i.test(value)) {
    await handleTree(bot, msg);
    return true;
  }

  if (/^(whoami|siapa kamu|siapa aku|identitas|kamu siapa|owner)$/i.test(value)) {
    await handleWhoami(bot, msg);
    return true;
  }

  const compoundCodingAction = /\b(?:lalu|terus|kemudian|setelah itu|dan)\b.*\b(?:eksekusi|terapkan|implementasi(?:kan)?|sync|sinkronkan|perbaiki|ubah|edit|poles|rapikan|jalankan)\b/i.test(value);
  const readPath = extractAfter(value, [/^(?:baca|lihat|read|tampilkan isi|buka file)\s+(.+)$/i]);
  if (readPath && extractNaturalPath(readPath) && !compoundCodingAction) {
    await handleRead(bot, msg, extractNaturalPath(readPath));
    return true;
  }

  const downloadPath = extractAfter(value, [/^(?:download|unduh|kirim file|ambil file)\s+(.+)$/i]);
  if (downloadPath && extractNaturalPath(downloadPath)) {
    await handleDownload(bot, msg, extractNaturalPath(downloadPath));
    return true;
  }

  const backupPath = extractAfter(value, [/^(?:backup|cadangkan|simpan cadangan)\s+(.+)$/i]);
  if (backupPath && extractNaturalPath(backupPath)) {
    await handleBackup(bot, msg, extractNaturalPath(backupPath));
    return true;
  }

  const deletePath = extractAfter(value, [/^(?:hapus|delete|buang|hilangkan)\s+(.+)$/i]);
  if (deletePath && extractNaturalPath(deletePath)) {
    await handleDelete(bot, msg, extractNaturalPath(deletePath));
    return true;
  }

  const rollbackPath = extractAfter(value, [/^(?:rollback|restore|balikin|kembalikan)(?:\s+(.+))?$/i]);
  if (/^(rollback|restore|balikin|kembalikan)/i.test(value)) {
    await handleRollback(bot, msg, rollbackPath ? extractNaturalPath(rollbackPath) || rollbackPath : "");
    return true;
  }

  const searchQuery = extractAfter(value, [/^(?:cari|search|grep|temukan kata|cari teks)\s+(.+)$/i]);
  if (searchQuery) {
    await handleSearch(bot, msg, searchQuery);
    return true;
  }

  return false;
}


async function handleAutonomousAction(bot, msg, text) {
  if (!isAutonomousRequest(text)) return false;
  // Use the modern tool-calling agent (Cursor/Claude Code style).
  await runToolAgent(bot, msg, text);
  return true;
}

/**
 * Tool-calling agent: AI eksplor project sendiri, edit pakai diff, verify build.
 * Lebih akurat & hemat token untuk task kompleks dibanding plan-based agent.
 */
async function runToolAgent(bot, msg, text) {
  const rate = checkRateLimit(`ai:${msg.from.id}`, config.aiRateLimit);
  if (!rate.allowed) {
    await reply(bot, msg, `Rate limit AI aktif. Coba lagi dalam ${formatRetryAfter(rate.retryAfterMs)}.`);
    return;
  }

  const projectDir = getActiveProjectDir();
  await sendTyping(bot, msg.chat.id);

  // Set up cancellation
  const chatId = msg.chat.id;
  const previous = activeAgentSessions.get(chatId);
  if (previous) {
    try { previous.abort.abort(); } catch {}
  }
  const controller = new AbortController();
  activeAgentSessions.set(chatId, {
    abort: controller,
    label: text.slice(0, 60),
    startedAt: Date.now()
  });

  // Track for /retry
  lastUserRequest.set(String(msg.from?.id), { kind: "agent", text, ts: Date.now() });

  // Capture any fallback events that fire during this agent run
  const fallbackEvents = [];
  const fallbackHandler = (info) => fallbackEvents.push(info);
  aiEvents.on("fallback", fallbackHandler);

  // Minimal monochrome icons per tool
  const toolGlyph = {
    list_dir: "▤",
    read_file: "▦",
    search: "⌕",
    write_file: "✎",
    apply_diff: "⌥",
    run_command: "⚡",
    git_status: "⎇",
    git_diff: "⎇",
    finish: "✓"
  };

  const projectName = path.basename(projectDir);
  const engineLabel = `${config.aiProvider}/${config.aiModel}`;

  const initial = [
    header("Agent", "tool-calling mode", { icon: T.agent }),
    `_${truncMid(text, 100)}_`,
    "",
    `${T.pending}  _menganalisis project & memilih tool pertama..._`
  ].join("\n");
  const live = await liveProgress(bot, msg, initial);

  try {
    const result = await runToolCallingAgent({
      projectDir,
      userRequest: text,
      userId: msg.from?.id,
      signal: controller.signal,
      onStep: async ({ step, max, log, current }) => {
        const recent = log.slice(-5).map((s) => {
          if (s.kind === "tool") {
            const g = toolGlyph[s.tool] || "·";
            const target = s.args?.path || s.args?.command || s.args?.pattern || "";
            const sym = s.ok ? T.ok : T.fail;
            return `${sym}  ${g} \`${s.tool}\`${target ? `  ${truncMid(target, 30)}` : ""}`;
          }
          if (s.kind === "ai_error") return `${T.fail}  AI error · ${truncMid(s.error, 50)}`;
          if (s.kind === "parse_error") return `${T.warn}  JSON parse error`;
          return "";
        }).filter(Boolean);

        const currentLine = current
          ? `${toolGlyph[current.tool] || "·"} _${current.tool}_${current.args?.path ? `  \`${truncMid(current.args.path, 28)}\`` : ""}`
          : "_thinking..._";

        const progress = `step ${step + 1}/${max}`;

        await live.update([
          header("Agent", progress, { icon: T.agent }),
          `_${truncMid(text, 80)}_`,
          "",
          recent.length ? recent.join("\n") : `${T.pending}  _starting..._`,
          "",
          `▸ ${currentLine}`
        ].join("\n"));
      }
    });

    // Auto-verify safety net
    let postVerify = null;
    if (result.files.length > 0) {
      const ranVerify = result.steps.some(
        (s) => s.kind === "tool" && s.tool === "run_command" && s.ok
      );
      if (!ranVerify) {
        await live.update([
          header("Agent", "verifying...", { icon: T.agent }),
          `${T.ok}  ${result.files.length} file(s) touched`,
          `${T.pending}  running auto-verify..._`
        ].join("\n"));
        postVerify = await runAutoVerifyResult(projectDir, msg.from?.id).catch(() => null);
      }
    }

    // Build final summary card
    const headlineState = result.aborted ? "Cancelled" : (result.success ? "Done" : "Stopped");
    const headlineIcon = result.aborted ? "■" : (result.success ? T.ok : T.warn);

    const verifyBadge = postVerify
      ? (postVerify.ok ? badge("ok", "verify") : badge("fail", "verify"))
      : "";

    const summaryLines = [
      header(`Agent ${headlineState.toLowerCase()}`, "", { icon: headlineIcon }),
      `_${truncMid(result.summary, 220)}_`
    ];

    // Stat row
    const statPairs = [
      ["files", String(result.files.length)],
      ["steps", String(result.steps.length)]
    ];
    if (result.usage) {
      statPairs.push(["tokens", `~${result.usage.estimatedTokens.toLocaleString()}`]);
    }
    summaryLines.push("", stats(statPairs));
    if (verifyBadge) summaryLines[summaryLines.length - 1] += `  ·  ${verifyBadge}`;

    if (result.files.length > 0) {
      summaryLines.push("", "*Files*");
      for (const f of result.files) summaryLines.push(`${T.bullet} \`${truncMid(f, 60)}\``);
    }

    const toolCounts = {};
    for (const s of result.steps) {
      if (s.kind === "tool") toolCounts[s.tool] = (toolCounts[s.tool] || 0) + 1;
    }
    if (Object.keys(toolCounts).length > 0) {
      summaryLines.push("", "*Tools used*");
      const toolLines = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([tool, count]) => `${toolGlyph[tool] || "·"} \`${tool}\` ×${count}`);
      summaryLines.push(toolLines.join("  ·  "));
    }

    if (postVerify && !postVerify.ok && postVerify.output) {
      summaryLines.push("", "*Build output*", code(truncateOutput(postVerify.output, 1200)));
    }

    if (fallbackEvents.length > 0) {
      summaryLines.push("", "*Auto-fallback*");
      const seen = new Set();
      for (const fb of fallbackEvents) {
        const key = `${fb.from}->${fb.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        summaryLines.push(`${T.bullet} \`${fb.from}\` ${T.arrow} \`${fb.to}\``);
      }
    }

    if (result.success && result.steps.length >= 5) {
      const toolNames = [...new Set(result.steps.filter((s) => s.kind === "tool").map((s) => s.tool))];
      await setLast("lastSuccessfulWorkflow", {
        summary: result.summary,
        files: result.files,
        tools: toolNames,
        verification: postVerify ? "auto verification executed" : "verification should run when available",
        trigger: text
      }).catch(() => {});
      summaryLines.push("", "Workflow ini bisa disimpan sebagai skill agar nanti tidak diulang dari nol.");
      summaryLines.push("Pakai `/skill save <name>` kalau mau menyimpan.");
    }

    // Crumb
    summaryLines.push(breadcrumb({ project: projectName, engine: engineLabel }));

    // Compact live finalize
    const finishLines = [
      header(`Agent ${headlineState.toLowerCase()}`, "", { icon: headlineIcon }),
      `_${truncMid(result.summary, 200)}_`,
      "",
      stats(statPairs) + (verifyBadge ? `  ·  ${verifyBadge}` : "")
    ];
    await live.finish(finishLines.join("\n"));

    // Suggestion chips
    const chips = [];
    if (result.files.length > 0) {
      chips.push({ text: "↶ Rollback", callback_data: "rollback_last" });
      chips.push({ text: "▣ Verify", callback_data: "cmd_verify_build" });
    }
    chips.push({ text: "↻ Retry", callback_data: "cmd_retry_last" });
    chips.push({ text: "← Coding", callback_data: "cmd_remote_coding" });

    if (!result.aborted) {
      await reply(bot, msg, summaryLines.join("\n"), {
        parse_mode: "Markdown",
        ...suggestionChips(chips)
      });
    }

    await recordTask({
      type: "tool_agent",
      projectDir,
      summary: truncateOutput(result.summary, 500),
      status: result.aborted ? "cancelled" : (result.success ? "confirmed" : "stopped")
    });
  } catch (err) {
    if (controller.signal.aborted) {
      await live.finish([
        header("Agent cancelled", "", { icon: "■" }),
        `_Dibatalkan oleh user._`
      ].join("\n"));
    } else {
      await live.finish([
        header("Agent error", "", { icon: T.fail }),
        `\`${err.message}\``,
        "",
        `_Coba_ \`/retry\` _atau ganti model via_ \`/engine\`_._`
      ].join("\n"));
    }
  } finally {
    aiEvents.off("fallback", fallbackHandler);
    if (activeAgentSessions.get(chatId)?.abort === controller) {
      activeAgentSessions.delete(chatId);
    }
  }
}


async function handleAutonomousFixBuild(bot, msg, originalText) {
  await progress(bot, msg, "Saya mulai autonomous fix loop terbatas: menjalankan build untuk menangkap error pertama.");
  const result = await runCommand("npm run build", getActiveProjectDir(), { userId: `agent-build:${msg.from.id}` });
  await setLast("command", "npm run build");

  if (result.ok) {
    await setLast("error", "");
    await reply(bot, msg, ["Build berhasil. Tidak ada error yang perlu difix.", "", summarizeCommandResult(result), "", result.output].join("\n"));
    return;
  }

  await setLast("error", result.output);
  const filePath = await inferFileFromText(getActiveProjectDir(), result.output);
  if (!filePath) {
    await reply(
      bot,
      msg,
      [
        "Build gagal, tapi aku belum bisa menentukan file target dari error.",
        "",
        summarizeCommandResult(result),
        "",
        "Reply pesan ini lalu sebut file target, contoh:",
        "fix error ini di src/App.jsx",
        "",
        truncateOutput(result.output, 1800)
      ].join("\n")
    );
    return;
  }

  await progress(bot, msg, `Saya menemukan file target dari error: ${filePath}. Saya siapkan patch preview sekarang.`);
  await stageEditPreview(bot, msg, {
    filePath,
    instruction: [
      "Perbaiki error build berikut. Ini iterasi 1 dari maksimal 3; berhenti di preview agar aman.",
      "",
      result.output,
      "",
      `Instruksi user: ${originalText}`
    ].join("\n"),
    type: "fix",
    sourceLabel: "autonomous build loop"
  });
}

function ruleBasedIntent(text, replyText = "") {
  const raw = String(text || "").trim();
  const lowered = `${raw}\n${replyText}`.toLowerCase();
  const fileRefs = lowered.match(/(?:src|app|pages|components|lib|utils|styles)[\\/][^\s'"`()]+?\.(?:jsx?|tsx?|json|css|scss|py|md)/i);

  // Pure greetings / chit-chat / Indonesian gaul — skip AI classifier
  if (/^(hi+|hai+|hei+|halo+|hello+|hellow|holla|yo+|yoo+|p|pp|tes|test|woi+|woy+|woe|bro+|bang|cuy|coy|gan|ges|guys|dab|sayang|bestie|bestiee|bjir|anjir|anjay|anjas|ehe|sup|wassup|whatsup|ehh|eh|hadeh|hadeuh|asw|asyu|hyung|kak|kaka|bestiee|bjirr|halooo|haii|haiii|haiiiii|halu)$/i.test(raw)) {
    return { intent: "ask_general", instruction: text, needsConfirmation: false };
  }
  if (/^(thanks+|thx+|makasih+|tq|terima kasih|trims+|sip+|ok+|oke+|okay+|okeh+|nice+|mantap+|mantul+|mantab+|cool+|gas+|gaskeun+|gaspol+|fix+|wokeh+|sip lah|noted+|siap+|siyap+|cuss+|cus+|kuy+|yuk+|yok+)$/i.test(raw)) {
    return { intent: "ask_general", instruction: text, needsConfirmation: false };
  }
  // Casual emotive replies / reactions — masuk ask_general (jangan dikira command)
  if (/^(wkwk+|wkwkw+|haha+|hehe+|huhu+|hihi+|hmm+|hmmm+|wadaw|waduh|astaga|astagfirullah|gila+|edan+|parah+|wah+|loh+|lah+|eh+|emang+|emangnya|masak+|masa+|seriusan|beneran|fr+|frfr|ngl|ngab|gabut+|cape+|capek+|aduh+|aaa+|ehe+|alah+|yaelah+|yalord+|yaampun+|yaallah|aw+|au+|bjir banget|anjir banget|gokil+|kocak+|lucu+|sad+|sedih+|happy+|seneng+|bahagia+|bored|boring+|bored bgt|laper+|lapar+|haus+|ngantuk+|sleepy+|tired+|excited+|hype+|stress+|stres+|depresi|galau+|baper+|sigma|skibidi|rizz)$/i.test(raw)) {
    return { intent: "ask_general", instruction: text, needsConfirmation: false };
  }
  // Pertanyaan singkat sapaan / curhat ringan
  if (/^(apa kabar|apakabar|kabar|how are you|hru|gimana kabarnya?|gmn kabarnya?|lagi apa|lg apa|lagi ngapain|ngapain|lg ngapain|lo lagi apa|kamu lagi apa|udah makan|udh makan|sibuk ga|sibuk gak|free ga|sibuk\??)$/i.test(raw)) {
    return { intent: "ask_general", instruction: text, needsConfirmation: false };
  }

  if (/\b(dev server|jalankan dev|jalanin dev|run dev|start dev|nyalain dev|nyalakan dev)\b/.test(lowered)) return { intent: "run_command", command: "npm run dev", instruction: text };
  if (/\b(build|compile)\b/.test(lowered) && /\b(run|jalankan|jalanin|cek|check|test|coba)\b/.test(lowered)) return { intent: "run_command", command: "npm run build", instruction: text };
  if (/\b(lint|format)\b/.test(lowered) && !/\bdetail\b/.test(lowered)) return { intent: "run_command", command: "npm run lint", instruction: text };
  if (/\b(jalankan test|jalanin test|run test|tes(t)? dulu)\b/.test(lowered)) return { intent: "run_command", command: "npm run test", instruction: text };
  if (/\b(git status|status git|gimana git|cek git)\b/.test(lowered)) return { intent: "run_command", command: "git status", instruction: text };
  if (/\b(git diff|diff git|liat diff)\b/.test(lowered)) return { intent: "run_command", command: "git diff", instruction: text };
  if (/\b(git pull|tarik git|pull dulu)\b/.test(lowered)) return { intent: "run_command", command: "git pull", instruction: text };
  if (/\b(git log|liat log git|history git)\b/.test(lowered)) return { intent: "run_command", command: "git log --oneline -10", instruction: text };
  if (/^(lanjut|lanjutkan|lanjutin|continue|coba lagi|fix lagi|sekali lagi|ulangi|ulangin)$/i.test(raw)) return { intent: "fix_file", filePath: fileRefs?.[0] || "", instruction: text, needsConfirmation: true };
  if (/\b(search|cari|grep|cariin|carikan)\b/.test(lowered) && raw.length > 8) return { intent: "search_project", query: raw.replace(/^(search|cari|grep|cariin|carikan)\s+/i, ""), instruction: text };
  if (/\b(read|baca|liat isi|lihat isi|bacain|tunjukin isi)\b/.test(lowered) && fileRefs) return { intent: "read_file", filePath: fileRefs[0], instruction: text };
  if (/\b(delete|hapus|hapusin|buang)\b/.test(lowered) && fileRefs) return { intent: "delete_file", filePath: fileRefs[0], instruction: text, needsConfirmation: true };
  if (/\b(rollback|balikin|balikkan|restore|undo|kembaliin)\b/.test(lowered)) return { intent: "rollback", filePath: fileRefs?.[0] || "", instruction: text, needsConfirmation: true };
  if (/\b(fix|perbaiki|perbaikin|benerin|benarin)\b/.test(lowered) || (/\b(error|rusak|gagal|bug)\b/.test(lowered) && /\b(tolong|please|pls|bantu|benahi|betulin|resolve|atasi)\b/.test(lowered))) return { intent: "fix_file", filePath: fileRefs?.[0] || "", instruction: text, needsConfirmation: true };
  if (/\b(edit|ubah|rapikan|rapiin|poles|tambah|tambahin|tambahkan|ganti)\b/.test(lowered) && fileRefs) return { intent: "edit_file", filePath: fileRefs[0], instruction: text, needsConfirmation: true };
  if (/\b(buat|buatin|buatkan|bikin|bikinin|create)\b/.test(lowered) && fileRefs) return { intent: "create_file", filePath: fileRefs[0], instruction: text, needsConfirmation: true };
  return null;
}

function fastPathIntent(text, replyText = "") {
  // Only return non-null if we are HIGHLY confident — else send to AI classifier.
  return ruleBasedIntent(text, replyText);
}

async function routeNaturalLanguage(text, msg) {
  const replyText = getReplyText(msg);
  const raw = String(text || "").trim();

  const isQuestionLike = /\?$/.test(raw) || /^(apa|apakah|kenapa|mengapa|gimana|bagaimana|siapa|kapan|dimana|how|why|what|who|when|where|can|could|should|is|are|do|does)\b/i.test(raw);
  const explicitActionRequest = /\b(jalankan|jalanin|eksekusi|terapkan|implementasi(?:kan)?|sync|sinkronkan|run|buat|buatin|bikin|create|edit|ubah|hapus|delete|fix|perbaiki|benerin|poles|rapikan|deploy|push|kill|rollback|restore|tunnel)\b/i.test(raw);
  if (isQuestionLike && !explicitActionRequest) {
    const looksTechnicalQuestion = /\b(project|kode|code|error|bug|build|compile|api|database|db|query|function|class|typescript|javascript|node|react|next|server|client|backend|frontend|src\/|components\/|utils\/)\b/i.test(raw);
    return {
      intent: looksTechnicalQuestion ? "ask_project" : "ask_general",
      instruction: text,
      needsConfirmation: false,
      reason: looksTechnicalQuestion ? "question_technical" : "question_general"
    };
  }

  // 1. Rule-based fast path (deterministic, instant).
  const fast = fastPathIntent(text, replyText);
  if (fast) return fast;

  // 2. Pesan pendek tanpa kata kerja command — langsung ask_general.
  // Ini cover banyak pesan natural ngobrol: "iya", "knp gitu", "menurut lo",
  // "wkwk parah", "btw lagi gabut", "ada rekomendasi anime ga", dll.
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  const looksLikeCommand = /\b(file|src\/|pages\/|components\/|push|deploy|kill|build|test|lint|fix|edit|create|hapus|delete|run|jalanin|eksekusi|terapkan|implementasi|sync|sinkronkan|poles|rapikan|tunnel|server|backup|zip|env|config)\b/i.test(raw);
  if (wordCount <= 12 && !looksLikeCommand) {
    return { intent: "ask_general", instruction: text, needsConfirmation: false };
  }

  // 3. Fall back to AI classifier untuk kasus ambigu.
  try {
    const memorySummary = await getMemorySummary(getActiveProjectDir());
    const classified = await classifyNaturalLanguageIntent({
      message: text,
      replyText,
      memorySummary
    });

    const confidence = Number(classified?.confidence);
    // Low-confidence safety: jangan eksekusi intent berisiko kalau model ragu.
    if (!Number.isFinite(confidence) || confidence < 0.58) {
      return {
        intent: "ask_general",
        instruction: text,
        needsConfirmation: false,
        confidence: Number.isFinite(confidence) ? confidence : 0.5,
        reason: `fallback_low_confidence:${classified?.intent || "unknown"}`
      };
    }

    return classified;
  } catch (err) {
    await logger.warn("AI intent classification failed, defaulting to ask_general", { error: err.message });
    return { intent: "ask_general", instruction: text, needsConfirmation: false, confidence: 0.5, reason: "classifier_error" };
  }
}

async function runAgentIntent(bot, msg, intent, originalText, inlineData = null) {
  const replyText = getReplyText(msg);
  const instruction = [intent.instruction || originalText, replyText ? `Konteks reply:\n${replyText}` : ""].filter(Boolean).join("\n\n");
  const lowered = `${originalText}\n${replyText}`.toLowerCase();

  await recordTask({
    type: "agent_intent",
    projectDir: getActiveProjectDir(),
    intent: intent.intent,
    instruction: truncateOutput(instruction, 1200),
    status: "started"
  });

  if (/\b(fix|perbaiki|benerin)\b/.test(lowered) && /\b(build|compile)\b/.test(lowered)) {
    await handleAutonomousFixBuild(bot, msg, originalText);
    return;
  }

  switch (intent.intent) {
    case "format_code":
      await handleFormat(bot, msg);
      return;
    case "git_push":
      await handlePush(bot, msg);
      return;
    case "zip_backup":
      await handleZipProject(bot, msg);
      return;
    case "sys_lock":
      await handlePCControl(bot, msg, "lock");
      return;
    case "sys_shutdown":
      await handlePCControl(bot, msg, "shutdown");
      return;
    case "sys_restart":
      await handlePCControl(bot, msg, "restart");
      return;
    case "get_logs":
      await handleLiveLogs(bot, msg);
      return;
    case "dashboard":
      await handleDashboard(bot, msg);
      return;
    case "deploy":
      await handleRun(bot, msg, "npx vercel --prod --yes");
      return;
    case "tunnel":
      await handleTunnel(bot, msg, intent.port || originalText.replace(/\D/g, ""));
      return;
    case "kill_port":
      await handleKillPort(bot, msg, intent.port || originalText.replace(/\D/g, ""));
      return;
    case "outline_file":
      if (!intent.filePath) throw new Error("Sebutkan nama file yang ingin dilihat kerangkanya.");
      await handleOutline(bot, msg, intent.filePath);
      return;
    case "status":
      await handleStatus(bot, msg);
      return;
    case "run_command":
      if (!intent.command) throw new Error("Agent tidak menemukan command yang aman untuk dijalankan.");
      await handleRun(bot, msg, intent.command);
      return;
    case "read_file":
      if (!intent.filePath) throw new Error("File yang ingin dibaca belum jelas.");
      await handleRead(bot, msg, intent.filePath);
      return;
    case "search_project":
      await handleSearch(bot, msg, intent.query || originalText);
      return;
    case "delete_file":
      if (!intent.filePath) {
        intent.filePath = await inferFileFromText(getActiveProjectDir(), `${originalText}\n${replyText}`);
      }
      if (!intent.filePath) {
        await reply(bot, msg, "File yang ingin dihapus belum jelas. Sebut path file, contoh: hapus src/unused.js");
        return;
      }
      await handleDelete(bot, msg, intent.filePath);
      return;
    case "rollback":
      await handleRollback(bot, msg, intent.filePath || "");
      return;
    case "fix_file": {
      const inferredFile = intent.filePath || (await inferFileFromText(getActiveProjectDir(), `${originalText}\n${replyText}`)) || (await getLast("filePath"));
      if (!inferredFile) {
        await reply(bot, msg, "File target belum jelas. Reply pesan error, atau sebut path file. Contoh: fix error di src/App.jsx");
        return;
      }
      await setLast("error", instruction);
      await stageEditPreview(bot, msg, {
        filePath: inferredFile,
        instruction,
        type: "fix",
        sourceLabel: msg.reply_to_message ? "pesan yang direply" : "teks command",
        inlineData
      });
      return;
    }
    case "edit_file": {
      if (!intent.filePath) {
        await reply(bot, msg, "File target belum jelas. Sebut path file yang ingin diedit.");
        return;
      }
      await stageEditPreview(bot, msg, {
        filePath: intent.filePath,
        instruction,
        type: "edit",
        sourceLabel: "natural chat",
        inlineData
      });
      return;
    }
    case "create_file": {
      if (!intent.filePath) throw new Error("Tentukan path file yang akan dibuat. Contoh: buat file src/pages/About.jsx ...");
      await stageCreatePreview(bot, msg, {
        filePath: intent.filePath,
        instruction,
        inlineData
      });
      return;
    }
    case "ask_project": {
      await sendTyping(bot, msg.chat.id);
      const askDir = getActiveProjectDir();
      try {
        const answer = await askProjectQuestion({
          projectDir: askDir,
          question: originalText,
          inlineData,
          contextHints: { userName: msg.from?.first_name || "" }
        });
        await rememberConversation({ userId: msg.from?.id, role: "assistant", text: answer, projectDir: askDir }).catch(() => {});
        await reply(bot, msg, answer);
      } catch (err) {
        await reply(bot, msg, `❌ *AI ERROR*\n══════════════════\n\`${err.message}\`\n\n_Cek koneksi AI provider atau jalankan_ \`/engine\` _untuk ganti model._`, { parse_mode: "Markdown" });
      }
      return;
    }
    case "ask_general":
    case "ask": {
      await sendTyping(bot, msg.chat.id);
      const askDir = getActiveProjectDir();
      try {
        const answer = await askGeneralQuestion({
          question: originalText,
          inlineData,
          projectDir: askDir,
          contextHints: { userName: msg.from?.first_name || "" }
        });
        await rememberConversation({ userId: msg.from?.id, role: "assistant", text: answer, projectDir: askDir }).catch(() => {});
        await reply(bot, msg, answer);
      } catch (err) {
        await reply(bot, msg, `❌ *AI ERROR*\n══════════════════\n\`${err.message}\`\n\n_Cek koneksi AI provider atau jalankan_ \`/engine\` _untuk ganti model._`, { parse_mode: "Markdown" });
      }
      return;
    }
    default: {
      await sendTyping(bot, msg.chat.id);
      const defaultDir = getActiveProjectDir();
      try {
        const answer = await askGeneralQuestion({
          question: originalText,
          inlineData,
          projectDir: defaultDir,
          contextHints: { userName: msg.from?.first_name || "" }
        });
        await rememberConversation({ userId: msg.from?.id, role: "assistant", text: answer, projectDir: defaultDir }).catch(() => {});
        await reply(bot, msg, answer);
      } catch (err) {
        await reply(bot, msg, `❌ *AI ERROR*\n══════════════════\n\`${err.message}\`\n\n_Cek koneksi AI provider atau jalankan_ \`/engine\` _untuk ganti model._`, { parse_mode: "Markdown" });
      }
    }
  }
}

// ── Shell Mode Handlers ──

function isShellMode(userId) {
  return shellModeUsers.has(String(userId));
}

function enterShellMode(userId) {
  shellModeUsers.add(String(userId));
}

function exitShellMode(userId) {
  shellModeUsers.delete(String(userId));
}

async function handleShellCommand(bot, msg, command) {
  const projectDir = getActiveProjectDir();

  // Approval guard for git push/force in raw shell mode.
  const trimmed = String(command || "").trim();
  if (/^git\s+push(\s|$)/i.test(trimmed)) {
    const force = /\s--force(?:-with-lease)?\b/i.test(trimmed);
    const status = await ensureGitRepo(projectDir, { needRemote: true });
    if (!status.ok) {
      await reply(bot, msg, `⚠️ *Push tidak bisa dijalankan*\n${status.reason}`, { parse_mode: "Markdown" });
      return;
    }
    const gh = parseGithubRemote(status.remote);
    const target = gh ? `${gh.owner}/${gh.repo} (branch ${status.branch})` : `${status.remote} (${status.branch})`;
    const ticket = await createApproval({
      service: "git",
      actionId: force ? "git:push-force" : "git:push",
      action: trimmed,
      target,
      payload: { branch: status.branch, remote: status.remote, command: trimmed },
      userId: msg.from?.id,
      chatId: msg.chat.id
    });
    await reply(bot, msg, formatApprovalMessage(ticket), { parse_mode: "Markdown" });
    return;
  }

  await sendTyping(bot, msg.chat.id);

  const userId = String(msg.from?.id || "");
  const shell = shellPreference.get(userId) || config.defaultShell;
  const result = await runShellCommand(command, projectDir, { userId, shell });

  const icon = result.ok ? "\u2705" : "\u274c";
  const output = [
    `${icon} \`${truncateOutput(result.command, 100)}\``,
    result.exitCode !== undefined && result.exitCode !== null ? `exit: ${result.exitCode}` : null,
    "",
    result.output
  ].filter(s => s !== null).join("\n");

  await sendLongMessage(bot, msg.chat.id, output);

  await setLast("command", result.command);
  if (!result.ok) await setLast("error", result.output);
  else await setLast("error", "");
  await recordTask({
    type: "shell",
    projectDir,
    command: result.command,
    summary: result.ok ? "success" : "failed",
    status: result.ok ? "success" : "failed"
  });
}

async function handleNaturalLanguage(bot, msg) {
  try {
    let inlineData = null;
    let text = msg.text || msg.caption || "";

    if (msg.voice) {
      await reply(bot, msg, [
        "Voice note belum didukung di mode ini.",
        "Kirim pertanyaan dalam teks ya."
      ].join("\n"));
      return;
    } else if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileUrl = await bot.getFileLink(photo.file_id);
      const resp = await fetch(fileUrl);
      const buf = await resp.arrayBuffer();
      inlineData = { data: Buffer.from(buf).toString("base64"), mimeType: "image/jpeg" };
    }

    if (!text && !inlineData) return;
    if (text) {
      await rememberConversation({
        userId: msg.from?.id,
        role: "user",
        text,
        projectDir: getActiveProjectDir()
      }).catch(() => {});
    }

    if (isShellMode(msg.from.id)) {
      if (/^(exit|keluar|tutup terminal|matikan shell|stop shell)$/i.test(text.trim())) {
        exitShellMode(msg.from.id);
        await reply(bot, msg, "Shell mode dimatikan. Kembali ke AI mode.");
        return;
      }
      await handleShellCommand(bot, msg, text);
      return;
    }

    const isCommandAlias = /^\$/i.test(text);
    if (isCommandAlias) {
      const runCmd = text.replace(/^\$/i, "").trim();
      
      if (runCmd.toLowerCase().startsWith("cd ") && !runCmd.includes("&&") && !runCmd.includes(";")) {
        const handled = await handleCdCommand(bot, msg, runCmd);
        if (handled) return;
        // If not handled (e.g. dir not found), we fallback to handleRun to show the shell error
      }

      await handleRun(bot, msg, runCmd);
      return;
    }

    // ── GitHub Device Flow login (natural language) ──
    if (/^(?:cancel|batal|stop)\s+login(?:\s+github)?$/i.test(text.trim())) {
      const sess = getLoginSession(msg.chat.id);
      if (sess) {
        try { sess.abort.abort(); } catch {}
        clearLoginSession(msg.chat.id);
        await reply(bot, msg, "🛑 Login GitHub dibatalkan.", { parse_mode: "Markdown" });
      } else {
        await reply(bot, msg, "_Tidak ada login yang sedang berjalan._", { parse_mode: "Markdown" });
      }
      return;
    }
    if (/^(?:login|connect|sign\s*in)\s+github\b/i.test(text.trim())
        || /^github\s+login\b/i.test(text.trim())) {
      await runGithubDeviceLogin(bot, msg);
      return;
    }

    // ── Connector intent (GitHub / Discord / X) — pre-empt natural-language ──
    // Kalimat seperti "push ke github aku", "cek repo github", "post ke x"
    // tidak boleh langsung jadi shell command. Routing-nya selalu lewat
    // connector intent supaya push wajib approval & action publik wajib draft.
    const connectorIntent = detectConnectorIntent(text);
    if (connectorIntent) {
      await handleConnectorIntent(bot, msg, connectorIntent, text);
      return;
    }

    if (await handleNaturalDirect(bot, msg, text)) return;

    // Chat mode: skip everything, langsung obrol natural
    if (chatModeUsers.has(String(msg.from?.id))) {
      await sendTyping(bot, msg.chat.id);
      const projectDir = getActiveProjectPath();
      try {
        const answer = await askGeneralQuestion({
          question: text,
          inlineData,
          projectDir,
          contextHints: { userName: msg.from?.first_name || "" }
        });
        await rememberConversation({ userId: msg.from?.id, role: "assistant", text: answer, projectDir }).catch(() => {});
        await reply(bot, msg, answer);
      } catch (err) {
        await reply(bot, msg, `❌ *AI ERROR*\n══════════════════\n\`${err.message}\``, { parse_mode: "Markdown" });
      }
      return;
    }

    // Natural-language agent trigger: "agent: ...", "ai agent ...", "owo agent ..."
    // Prefix eksplisit langsung masuk tool-calling agent; request coding yang jelas
    // juga bisa auto-trigger lewat heuristik isAutonomousRequest().
    const agentTriggerMatch = text.match(/^\s*(?:agent\s*[:!]?\s*|ai\s+agent\s+|hey\s+agent\s+|owo\s+agent\s+|o-w-o\s+agent\s+|coding\s+agent\s+|tolong\s+agent\s+|@?agent\s+)(.+)/i);
    if (agentTriggerMatch) {
      await runToolAgent(bot, msg, agentTriggerMatch[1].trim());
      return;
    }

    // Auto-trigger autonomous agent untuk request coding yang jelas.
    // Guard: hanya aktif kalau pesan terlihat seperti request implementasi kode,
    // sesuai heuristik isAutonomousRequest() di src/ai/agent.js.
    if (await handleAutonomousAction(bot, msg, text)) return;

    await sendTyping(bot, msg.chat.id);
    const intent = await routeNaturalLanguage(text, msg);
    await runAgentIntent(bot, msg, intent, text, inlineData);
  } finally {
    // Note: actual AI responses are recorded in individual handlers (ask, edit, fix, create)
    // This catch-all only records for cases where a handler doesn't record explicitly
  }
}

/**
 * Helper: run auto verify and return the raw result object.
 */
async function runAutoVerifyResult(projectDir, userId) {
  const command = await chooseVerifyCommand(projectDir);
  if (!command) return null;
  const result = await runCommand(command, projectDir, { userId: `verify:${userId}` });
  await setLast("command", command);
  if (!result.ok) await setLast("error", result.output);
  else await setLast("error", "");
  return { ok: result.ok, command, output: result.output || "" };
}

function formatGlobalError(errorMsg) {
  const raw = redactSecrets(String(errorMsg || "Unknown error"));
  const safeInline = raw.replace(/`/g, "'").slice(0, 1600);

  let suggestion = "Ketik /help untuk bantuan lebih lanjut.";
  const lowered = raw.toLowerCase();

  if (lowered.includes("format:")) {
    suggestion = "Periksa kembali format penulisan command.";
  } else if (lowered.includes("project") && lowered.includes("belum ada")) {
    suggestion = "Gunakan /projects untuk membuka atau membuat project.";
  } else if (lowered.includes("ai") || lowered.includes("model")) {
    suggestion = "Cek koneksi AI atau jalankan /engine untuk ganti model.";
  } else if (lowered.includes("timeout") || lowered.includes("rate limit")) {
    suggestion = "Tunggu beberapa saat lalu coba lagi.";
  } else if (lowered.includes("file") || lowered.includes("path")) {
    suggestion = "Pastikan path file benar. Cek dengan /projects.";
  } else if (lowered.includes("terminal") || lowered.includes("shell")) {
    suggestion = "Coba ulangi command. Jika tetap gagal, cek environment shell.";
  }

  return [
    "*SYSTEM ERROR*",
    "------------------",
    "```",
    safeInline,
    "```",
    "",
    "*Saran:*",
    suggestion
  ].join("\n");
}

// ─────────────────────────────────────────────
// Connector handlers (GitHub / Discord / X)
// ─────────────────────────────────────────────

function formatStatusValue(value) {
  if (value === null || value === undefined || value === "") return "_kosong_";
  if (Array.isArray(value)) return value.length ? "`" + value.join(", ") + "`" : "_kosong_";
  return "`" + String(value) + "`";
}

function renderConnectorRow(item) {
  const dot = item.enabled ? "🟢" : "⚪";
  const cred = item.status?.hasCredential || item.status?.hasUserContext || item.status?.hasAppContext;
  const credIcon = cred ? "🔐" : "🚫";
  const lastIdent = item.status?.lastIdentity ? ` · ${item.status.lastIdentity}` : "";
  return `${dot} *${item.label}* (\`${item.id}\`) ${credIcon}${lastIdent}`;
}

async function handleConnectorsList(bot, msg) {
  const items = listConnectors();
  const lines = [
    "*Connector status*",
    "------------------",
    ...items.map(renderConnectorRow),
    "",
    "Pakai natural language atau:",
    "`/connector status <service>`",
    "`/connector test <service>`",
    "`/connector refresh <service>`",
    "",
    "_Service: github, discord, x_"
  ];
  await reply(bot, msg, lines.join("\n"), { parse_mode: "Markdown" });
}

async function handleConnectorSubcommand(bot, msg, args) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] || "").toLowerCase();
  const service = tokens[1];

  if (!sub) {
    await handleConnectorsList(bot, msg);
    return;
  }

  if (!service && sub === "status") {
    await handleConnectorsList(bot, msg);
    return;
  }

  if (!service) {
    await reply(
      bot,
      msg,
      [
        "Format: `/connector <status|test|refresh> <github|discord|x>`",
        "Contoh: `/connector test github`"
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const serviceId = resolveServiceId(service);
  if (!serviceId) {
    await reply(bot, msg, `Service \`${service}\` tidak dikenal. Pilihan: github, discord, x.`, {
      parse_mode: "Markdown"
    });
    return;
  }
  const connector = getConnector(serviceId);

  if (sub === "status") {
    const res = await statusConnector(serviceId);
    if (!res.ok) {
      await reply(bot, msg, `❌ ${res.reason}`, { parse_mode: "Markdown" });
      return;
    }
    const s = res.status;
    const lines = [
      `*Status ${connector.label}*`,
      "------------------",
      `Enabled: ${s.enabled ? "✅" : "⚪ off"}`,
      s.hasCredential !== undefined ? `Credential: ${s.hasCredential ? "🔐 ada" : "🚫 belum diisi"}` : null,
      s.hasUserContext !== undefined ? `User context: ${s.hasUserContext ? "🔐" : "🚫"}` : null,
      s.hasAppContext !== undefined ? `App context: ${s.hasAppContext ? "🔐" : "🚫"}` : null,
      s.tokenPreview ? `Token: ${formatStatusValue(s.tokenPreview)}` : null,
      s.apiKeyPreview ? `API key: ${formatStatusValue(s.apiKeyPreview)}` : null,
      s.bearerPreview ? `Bearer: ${formatStatusValue(s.bearerPreview)}` : null,
      s.allowedGuildId !== undefined ? `Guild: ${formatStatusValue(s.allowedGuildId)}` : null,
      s.allowedChannelIds !== undefined ? `Channels: ${formatStatusValue(s.allowedChannelIds)}` : null,
      s.defaultOwner !== undefined ? `Default owner: ${formatStatusValue(s.defaultOwner)}` : null,
      s.defaultRepo !== undefined ? `Default repo: ${formatStatusValue(s.defaultRepo)}` : null,
      s.lastIdentity ? `Last identity: ${formatStatusValue(s.lastIdentity)}` : null
    ].filter(Boolean);
    await reply(bot, msg, lines.join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "refresh") {
    const res = await refreshConnector(serviceId);
    if (!res.ok) {
      await reply(bot, msg, `❌ ${res.reason}`, { parse_mode: "Markdown" });
      return;
    }
    await reply(bot, msg, `🔄 *${connector.label}* client di-refresh.`, { parse_mode: "Markdown" });
    return;
  }

  if (sub === "test") {
    await sendTyping(bot, msg.chat.id);
    const res = await testConnector(serviceId);
    if (!res.ok) {
      const lines = [
        `❌ *${connector.label} gagal connect*`,
        "------------------",
        `\`${truncateOutput(res.reason || "unknown", 600)}\``,
        res.help ? `\n${res.help}` : null
      ].filter(Boolean);
      await reply(bot, msg, lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }
    const ident = res.identity
      ? Object.entries(res.identity).map(([k, v]) => `${k}: \`${v ?? "-"}\``).join("\n")
      : "_(no identity payload)_";
    const extras = [];
    if (typeof res.allowedChannelCount === "number") {
      extras.push(`Allowed channels: \`${res.allowedChannelCount}\``);
    }
    await reply(
      bot,
      msg,
      [
        `✅ *${connector.label} terhubung*`,
        "------------------",
        ident,
        ...extras
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  await reply(
    bot,
    msg,
    "Subcommand tidak dikenal. Pakai `status`, `test`, atau `refresh`.",
    { parse_mode: "Markdown" }
  );
}

async function handleApproveCommand(bot, msg, args) {
  const id = String(args || "").trim().split(/\s+/)[0];
  if (!id) {
    await reply(bot, msg, "Format: `/approve <id>`", { parse_mode: "Markdown" });
    return;
  }
  await sendTyping(bot, msg.chat.id);
  const res = await approveById({ id, userId: msg.from?.id });
  if (!res.ok) {
    await reply(bot, msg, `❌ ${res.reason}`, { parse_mode: "Markdown" });
    return;
  }
  const ticket = res.ticket;

  if (!res.runByConnector && ticket.payload?.command && !["git:push", "github:push", "git:push-force"].includes(ticket.actionId)) {
    await reply(bot, msg, `Approved \`${ticket.id}\` - menjalankan command lewat safe executor...`, {
      parse_mode: "Markdown"
    });
    const projectDir = getActiveProjectDir();
    const result = await runCommand(ticket.payload.command, projectDir, {
      userId: String(msg.from?.id),
      approved: true
    });
    await reply(
      bot,
      msg,
      result.ok
        ? `Command sukses.\n\`\`\`\n${truncateOutput(result.output, 1500)}\n\`\`\``
        : `Command gagal.\n\`\`\`\n${truncateOutput(result.output, 1500)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (!res.runByConnector) {
    if (ticket.actionId === "git:push" || ticket.actionId === "github:push") {
      await reply(
        bot,
        msg,
        `✅ *Approved* \`${ticket.id}\` — menjalankan \`git push\`...`,
        { parse_mode: "Markdown" }
      );
      const projectDir = getActiveProjectDir();
      const command = ticket.payload?.command || "git push";
      const result = await runCommand(command, projectDir, { userId: String(msg.from?.id), approved: true });
      await reply(
        bot,
        msg,
        result.ok
          ? `☁️ *PUSH SUCCESS*\n\`\`\`\n${truncateOutput(result.output, 1500)}\n\`\`\``
          : `❌ *PUSH FAILED*\n\`\`\`\n${truncateOutput(result.output, 1500)}\n\`\`\``,
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (ticket.actionId === "git:push-force") {
      await reply(bot, msg, `⚠️ *Approved* \`${ticket.id}\` — \`git push --force-with-lease\`...`, { parse_mode: "Markdown" });
      const projectDir = getActiveProjectDir();
      const command = ticket.payload?.command || "git push --force-with-lease";
      const result = await runCommand(command, projectDir, { userId: String(msg.from?.id), approved: true });
      await reply(
        bot,
        msg,
        result.ok ? `✅ Force push sukses.` : `❌ Force push gagal:\n\`\`\`\n${truncateOutput(result.output, 1500)}\n\`\`\``,
        { parse_mode: "Markdown" }
      );
      return;
    }
    await reply(bot, msg, `✅ *Approved* \`${ticket.id}\` (\`${ticket.actionId}\`). Tidak ada handler otomatis.`, {
      parse_mode: "Markdown"
    });
    return;
  }

  if (res.exec?.ok) {
    const data = res.exec.data;
    let summary = "_OK_";
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const keys = Object.keys(data).slice(0, 6);
      summary = keys.map((k) => `${k}: \`${truncateOutput(String(data[k] ?? "-"), 80)}\``).join("\n") || "_OK_";
    } else if (Array.isArray(data)) {
      summary = `_${data.length} item_`;
    } else if (data) {
      summary = truncateOutput(String(data), 600);
    }
    await reply(
      bot,
      msg,
      [
        `✅ *Approved & executed* \`${ticket.id}\``,
        `Service: \`${ticket.service}\``,
        `Action: \`${ticket.action}\``,
        "------------------",
        summary
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } else {
    await reply(
      bot,
      msg,
      [
        `⚠️ *Approved tapi gagal eksekusi* \`${ticket.id}\``,
        `Reason: \`${truncateOutput(res.exec?.reason || res.exec?.error || "unknown", 600)}\``
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  }
}

async function handleRejectCommand(bot, msg, args) {
  const id = String(args || "").trim().split(/\s+/)[0];
  if (!id) {
    await reply(bot, msg, "Format: `/reject <id>`", { parse_mode: "Markdown" });
    return;
  }
  const res = await rejectById({ id, userId: msg.from?.id });
  if (!res.ok) {
    await reply(bot, msg, `❌ ${res.reason}`, { parse_mode: "Markdown" });
    return;
  }
  await reply(bot, msg, `🛑 *Rejected* \`${res.ticket.id}\` (\`${res.ticket.actionId}\`).`, {
    parse_mode: "Markdown"
  });
}

// ─────────────────────────────────────────────
// GitHub Device Flow login
// ─────────────────────────────────────────────

async function handleLoginCommand(bot, msg, args) {
  const target = String(args || "").trim().toLowerCase().split(/\s+/)[0] || "github";
  if (target !== "github") {
    await reply(
      bot,
      msg,
      [
        "Saat ini hanya `login github` yang didukung lewat bot.",
        "Discord pakai bot token (`DISCORD_BOT_TOKEN`), X pakai API keys (`X_API_KEY`...).",
        "Edit `.env` langsung untuk service tersebut, atau jalankan `/connector test <service>`."
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }
  await runGithubDeviceLogin(bot, msg);
}

async function runGithubDeviceLogin(bot, msg) {
  const chatId = msg.chat.id;

  // Cancel any existing login session for this chat.
  const existing = getLoginSession(chatId);
  if (existing) {
    try { existing.abort.abort(); } catch {}
    clearLoginSession(chatId);
  }

  await sendTyping(bot, chatId);

  let device;
  try {
    device = await startDeviceFlow();
  } catch (err) {
    await reply(
      bot,
      msg,
      [
        "❌ *Gagal memulai login GitHub*",
        "------------------",
        `\`${truncateOutput(err.message, 600)}\``,
        "",
        "Cek koneksi internet atau set `GITHUB_OAUTH_CLIENT_ID` di `.env` kalau perlu pakai OAuth app sendiri."
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const verifyUrl = device.verificationUriComplete || device.verificationUri;
  const expireMin = Math.round(device.expiresIn / 60);

  await reply(
    bot,
    msg,
    [
      "🔐 *Login GitHub*",
      "------------------",
      "Buka link ini di browser HP/laptop:",
      `${verifyUrl}`,
      "",
      "Login pakai email & password GitHub kamu di sana.",
      "Lalu masukin kode ini:",
      "",
      `\`${device.userCode}\``,
      "",
      `_Kode berlaku ~${expireMin} menit. Bot akan auto-deteksi setelah kamu approve._`,
      "",
      "Ketik `cancel login` untuk batalkan."
    ].join("\n"),
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );

  const controller = new AbortController();
  trackLoginSession(chatId, { abort: controller, deviceCode: device.deviceCode, startedAt: Date.now() });

  let result;
  try {
    result = await pollForToken({
      deviceCode: device.deviceCode,
      interval: device.interval,
      expiresIn: device.expiresIn,
      signal: controller.signal
    });
  } catch (err) {
    clearLoginSession(chatId);
    await reply(bot, msg, `❌ Login error: \`${truncateOutput(err.message, 400)}\``, { parse_mode: "Markdown" });
    return;
  }

  clearLoginSession(chatId);

  if (!result.ok) {
    await reply(bot, msg, `❌ ${result.reason}`, { parse_mode: "Markdown" });
    return;
  }

  // Verify token + ambil username.
  await sendTyping(bot, chatId);
  let username = "";
  try {
    const verifyRes = await axiosOnce("https://api.github.com/user", result.accessToken);
    if (verifyRes.ok && verifyRes.data?.login) {
      username = String(verifyRes.data.login);
    }
  } catch {}

  await persistTokenToEnv(result.accessToken, { username });
  // Refresh connector (singleton octokit di-rebuild).
  try {
    const { refreshConnector } = await import("../connectors/connectorManager.js");
    await refreshConnector("github");
  } catch {}

  await reply(
    bot,
    msg,
    [
      "✅ *GitHub login sukses*",
      "------------------",
      username ? `User: \`${username}\`` : null,
      `Scopes: \`${truncateOutput(result.scope || "(default)", 200)}\``,
      "",
      "Token disimpan di `.env` (GITHUB_TOKEN) dan connector diaktifkan.",
      "Coba: `cek repo gue` atau `/connector test github`."
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function axiosOnce(url, token) {
  try {
    const { default: axios } = await import("axios");
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "telegram-coding-agent",
        Accept: "application/vnd.github+json"
      },
      timeout: 12000,
      validateStatus: () => true
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// Natural-language connector intent detection
// ─────────────────────────────────────────────

function detectConnectorIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();

  // ── GitHub: push (natural language) — wajib approval ──
  const githubPushPatterns = [
    /\bpush\s+(?:ke\s+)?github(?:\s+(?:gw|gue|aku))?\b/,
    /\bpush\s*kan\s+(?:ke\s+)?github(?:\s+(?:aku|gue|gw))?\b/,
    /\bunggah\s+(?:kode|project)?\s*(?:ke\s+)?github\b/,
    /\bupload\s+(?:kode|project)?\s*(?:ke\s+)?github\b/,
    /\bkirim\s+(?:kode|project)?\s*(?:ke\s+)?github\b/,
    /\bpush\s+project\s+ini\b/,
    /^push$/,
    /^git\s+push$/
  ];
  for (const pattern of githubPushPatterns) {
    if (pattern.test(lowered)) {
      return {
        service: "git",
        action: "push",
        label: "push ke GitHub (git push)",
        actionId: "git:push",
        requireRepo: true,
        requireRemote: true
      };
    }
  }

  if (/\b(?:cek|test|periksa|coba)\s+(?:koneksi|connection|sambungan)\s+github\b/.test(lowered)
      || /\bgithub\s+(?:nya\s+)?(?:konek|tersambung|nyambung)\b/.test(lowered)
      || /\btest\s+github\b/.test(lowered)) {
    return { service: "github", action: "testConnection", label: "test GitHub", actionId: "github:ping" };
  }

  if (/\b(?:list|daftar|lihat|cek|tampilkan)\s+repo(?:s|sitor[iy])?\s+(?:gue|gw|aku|github)?\b/.test(lowered)
      || /\bcek\s+repo\s+github\b/.test(lowered)
      || /\brepo\s+github\s+(?:gue|gw|aku)\b/.test(lowered)) {
    return { service: "github", action: "listRepos", label: "list GitHub repos", actionId: "github:list_repos" };
  }

  if (/\b(?:cek|lihat|list|daftar)\s+branch(?:es)?\s+(?:di\s+)?github\b/.test(lowered)
      || /\bbranch\s+github\s+(?:gue|gw|aku)?/.test(lowered)) {
    return { service: "github", action: "listBranches", label: "list branches", actionId: "github:list_branches" };
  }

  if (/\b(?:cek|lihat|list|daftar|tampilkan)\s+issue\s+(?:terbaru\s+)?(?:di\s+)?github\b/.test(lowered)
      || /\bissue\s+github\s+(?:terbaru|terakhir)?/.test(lowered)) {
    return { service: "github", action: "listIssues", label: "list issues", actionId: "github:list_issues" };
  }

  const issueCreatePattern = /\b(?:buat|bikin|tambah(?:kan)?)\s+issue(?:\s+github)?(?:\s+(?:dari\s+error\s+ini|untuk\s+error\s+ini))?(?:\s*[:：]\s*(.+))?$/;
  if (issueCreatePattern.test(lowered)) {
    const match = raw.match(/(?:[:：])\s*(.+)$/);
    return {
      service: "github",
      action: "createIssue",
      label: "buat GitHub issue",
      actionId: "github:create_issue",
      payload: match ? { title: match[1].slice(0, 200), body: "" } : null
    };
  }

  if (/\b(?:cek|lihat|list|daftar)\s+(?:pull\s*request|pr|PR)s?\b/.test(lowered)) {
    return { service: "github", action: "listPullRequests", label: "list PRs", actionId: "github:list_pull_requests" };
  }

  if (/\b(?:buat|bikin)\s+(?:pull\s*request|pr|PR)\s+(?:dari|untuk)?\s*branch/.test(lowered)
      || /\bbuat\s+pr\b/.test(lowered)) {
    return {
      service: "github",
      action: "createPullRequest",
      label: "buat Pull Request",
      actionId: "github:create_pr"
    };
  }

  if (/\b(?:cek|lihat|status)\s+workflow(?:s)?\s+(?:github|actions)?/.test(lowered)
      || /\bgithub\s+actions\s+(?:status|terakhir|terbaru)?/.test(lowered)) {
    return {
      service: "github",
      action: "listWorkflowRuns",
      label: "cek workflow runs",
      actionId: "github:list_workflow_runs"
    };
  }

  if (/\b(cek|test|periksa)\s+(?:koneksi|connection)\s+discord\b/.test(lowered)
      || /\btest\s+discord\b/.test(lowered)) {
    return { service: "discord", action: "testConnection", label: "test Discord", actionId: "discord:ping" };
  }

  if (/\bkirim\s+(?:status\s+)?(?:build|test|notif|notifikasi|laporan)\s+(?:ke\s+)?discord\b/.test(lowered)
      || /\bnotif\s+discord\b/.test(lowered)) {
    return {
      service: "discord",
      action: "sendMessage",
      label: "kirim status ke Discord",
      actionId: "discord:send_message_allowed",
      payload: { content: "" }
    };
  }

  if (/\b(cek|test|periksa)\s+(?:koneksi|connection)\s+(?:x|twitter)\b/.test(lowered)
      || /\btest\s+(?:x|twitter)\b/.test(lowered)) {
    return { service: "x", action: "testConnection", label: "test X/Twitter", actionId: "x:ping" };
  }

  if (/\b(?:buat|bikin)\s+draft\s+tweet\b/.test(lowered)
      || /\bdraft\s+tweet\s+(?:tentang|dari|update)/.test(lowered)
      || /\bdraft\s+(?:post|tweet)\s+(?:di\s+)?(?:x|twitter)\b/.test(lowered)) {
    return { service: "x", action: "buildDraft", label: "draft tweet", actionId: "x:draft_post" };
  }

  if (/\bpost\s+(?:ke\s+)?(?:x|twitter)\b/.test(lowered)
      || /\btweet\s+(?:ini|sekarang|baru)\b/.test(lowered)
      || /\bnge\s*tweet\b/.test(lowered)) {
    return { service: "x", action: "postTweet", label: "post tweet", actionId: "x:post_tweet" };
  }

  return null;
}

async function handleConnectorIntent(bot, msg, intent, originalText) {
  if (intent.service === "git" && intent.action === "push") {
    const projectDir = getActiveProjectDir();
    const status = await ensureGitRepo(projectDir, { needRemote: true });
    if (!status.ok) {
      await reply(bot, msg, `⚠️ *Push tidak bisa dijalankan*\n${status.reason}`, {
        parse_mode: "Markdown"
      });
      return;
    }
    const gh = parseGithubRemote(status.remote);
    const target = gh ? `${gh.owner}/${gh.repo} (branch ${status.branch})` : `${status.remote} (${status.branch})`;
    const ticket = await createApproval({
      service: "git",
      actionId: "git:push",
      action: "git push",
      target,
      payload: { branch: status.branch, remote: status.remote },
      userId: msg.from?.id,
      chatId: msg.chat.id
    });
    await reply(bot, msg, formatApprovalMessage(ticket), { parse_mode: "Markdown" });
    return;
  }

  const connector = getConnector(intent.service);
  if (!connector) {
    await reply(bot, msg, `Service \`${intent.service}\` belum tersedia.`, { parse_mode: "Markdown" });
    return;
  }
  if (!connector.isEnabled()) {
    await reply(
      bot,
      msg,
      [
        `⚪ *${connector.label} connector belum aktif*`,
        "------------------",
        connector.envHelp?.() || "Aktifkan dulu via .env."
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (intent.action === "testConnection") {
    await handleConnectorSubcommand(bot, msg, `test ${intent.service}`);
    return;
  }

  if (intent.service === "x" && intent.action === "buildDraft") {
    const draftText = String(originalText || "").replace(/^.*?(?:tentang|update|:)\s*/i, "").trim() || originalText;
    const draft = connector.buildDraft({ text: draftText });
    if (!draft.ok) {
      await reply(bot, msg, `❌ ${draft.error}`, { parse_mode: "Markdown" });
      return;
    }
    await reply(
      bot,
      msg,
      [
        "*Draft tweet*",
        "------------------",
        `\`\`\`\n${truncateOutput(draft.draft, 1000)}\n\`\`\``,
        draft.warning ? `\n_${draft.warning}_` : null,
        "",
        "Untuk publish ketik: `post ke x: <isi tweet>` (akan minta approval)."
      ].filter(Boolean).join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  let payload = intent.payload || {};
  if (intent.service === "discord" && intent.action === "sendMessage") {
    const list = config.discordAllowedChannelIds || [];
    if (!list.length) {
      await reply(
        bot,
        msg,
        [
          "Channel allowlist Discord kosong.",
          "Set `DISCORD_ALLOWED_CHANNEL_IDS=ch1,ch2` di `.env` dulu."
        ].join("\n"),
        { parse_mode: "Markdown" }
      );
      return;
    }
    const content = String(originalText || "").replace(/^.*?(?:ke\s+discord)/i, "").trim() || "📣 Status update dari bot";
    payload = { channelId: list[0], content };
    if (/@(everyone|here)\b/i.test(payload.content)) {
      intent.actionId = "discord:mention_everyone";
      intent.label = "kirim Discord dengan mention everyone/here";
      payload.allowEveryone = true;
    }
  }

  if (intent.service === "x" && intent.action === "postTweet") {
    payload = { text: String(originalText || "").replace(/^.*?(?:post|tweet)\s*[:：]?\s*/i, "").trim() };
    if (!payload.text) {
      await reply(bot, msg, "Isi tweet kosong. Coba: `post ke x: hello world`.", { parse_mode: "Markdown" });
      return;
    }
  }

  if (intent.service === "github" && intent.action === "createIssue" && !payload.title) {
    await reply(bot, msg, [
      "Issue draft butuh title.",
      "Format: `buat issue github: <title>`",
      "Actual create issue tetap lewat approval."
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }

  const result = await executeAction({
    service: intent.service,
    action: intent.action,
    actionId: intent.actionId,
    label: intent.label,
    target: intent.target || "",
    payload,
    userId: msg.from?.id,
    chatId: msg.chat.id
  });

  if (result.needsApproval) {
    await reply(bot, msg, result.message, { parse_mode: "Markdown" });
    return;
  }
  if (!result.ok) {
    await reply(
      bot,
      msg,
      [
        `❌ *${connector.label} action gagal*`,
        `Action: \`${intent.label}\``,
        "------------------",
        `\`${truncateOutput(result.reason || result.raw?.error || "unknown", 600)}\``
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const data = result.data;
  let summary = "_OK_";
  if (Array.isArray(data)) {
    const items = data.slice(0, 8).map((it, i) => {
      if (it?.full_name) return `${i + 1}. \`${it.full_name}\``;
      if (it?.title) return `${i + 1}. #${it.number || "?"} ${truncateOutput(it.title, 80)}`;
      if (it?.name) return `${i + 1}. \`${it.name}\``;
      if (it?.id) return `${i + 1}. \`${it.id}\``;
      return `${i + 1}. ${truncateOutput(JSON.stringify(it), 80)}`;
    });
    summary = items.length ? items.join("\n") : "_kosong_";
  } else if (data?.workflow_runs && Array.isArray(data.workflow_runs)) {
    summary = data.workflow_runs.slice(0, 5).map((run, i) =>
      `${i + 1}. \`${run.name || run.workflow_id}\` · ${run.status} · ${run.conclusion || "-"} · ${run.head_branch || ""}`
    ).join("\n") || "_tidak ada run_";
  } else if (data && typeof data === "object") {
    const interesting = ["login", "name", "html_url", "default_branch", "private", "public_repos", "id", "number"];
    summary = interesting
      .filter((k) => data[k] !== undefined)
      .map((k) => `${k}: \`${truncateOutput(String(data[k] ?? "-"), 80)}\``)
      .join("\n") || truncateOutput(JSON.stringify(data, null, 2), 600);
  } else if (data) {
    summary = truncateOutput(String(data), 600);
  }

  await reply(
    bot,
    msg,
    [
      `✅ *${connector.label}* — ${intent.label}`,
      "------------------",
      summary
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

export function registerCommands(bot) {
  // Only register minimal essential slash commands in Telegram menu
  bot.setMyCommands([
    { command: "start", description: "Mulai bot" },
    { command: "help", description: "Cara pakai" },
    { command: "status", description: "Status agent dan project" },
    { command: "whoami", description: "Lihat user/chat id" },
    { command: "agent", description: "Jalankan coding agent" },
    { command: "ask", description: "Tanya project atau umum" },
    { command: "files", description: "Lihat struktur file" },
    { command: "read", description: "Baca file aman" },
    { command: "write", description: "Preview write file" },
    { command: "edit", description: "Preview edit AI" },
    { command: "run", description: "Run safe command" },
    { command: "backup", description: "Backup file" },
    { command: "memory", description: "Kelola memory" },
    { command: "skills", description: "Kelola skills" },
    { command: "approvals", description: "Daftar approval pending" },
    { command: "connector", description: "status|test|refresh <service>" },
    { command: "login", description: "Login connector" },
    { command: "approve", description: "Setujui approval ticket" },
    { command: "reject", description: "Tolak approval ticket" }
  ]).catch(() => {});

  bot.on("callback_query", async (query) => {
    const msg = query.message ? { ...query.message, from: query.from } : null;
    try {
      if (!msg || !isAdminUser(query.from?.id)) {
        await bot.answerCallbackQuery(query.id, { text: "Tidak diizinkan." }).catch(() => {});
        return;
      }
      await syncActiveSession();
      await bot.answerCallbackQuery(query.id).catch(() => {});

      // Hapus pesan lama agar chat tidak tertimbun (Kecuali tombol media, volume, scroll agar tidak hilang!)
      const isPersistentAction = query.data && (
        query.data.startsWith("cmd_media_") ||
        query.data.startsWith("cmd_spotify_") ||
        query.data.startsWith("cmd_scroll_") ||
        query.data.startsWith("cmd_mouse_") ||
        query.data === "cmd_media_panel" ||
        query.data === "cmd_scroll_menu" ||
        query.data === "cmd_fullscreen" ||
        query.data === "cmd_browser_close_tab" ||
        query.data === "cmd_pc_minimize" ||
        query.data === "cmd_pc_restore" ||
        query.data === "cmd_pc_maximize" ||
        query.data === "cmd_feed_pause"
      );
      if (!isPersistentAction) {
        await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      }

      switch (query.data) {
        case "browser_mode_google":
          browserSearchMode.set(msg.chat.id, { mode: "google", ts: Date.now() });
          await reply(bot, msg, `🔍 *CARI DI GOOGLE*\n══════════════════\n_Ketik kata pencarian:_`, {
            reply_markup: { force_reply: true }
          });
          break;
        case "browser_mode_spotify":
          browserSearchMode.set(msg.chat.id, { mode: "spotify", ts: Date.now() });
          await reply(bot, msg, `▶️🎵 *PUTAR DI SPOTIFY WEB*\n══════════════════\n_Ketik judul lagu yang ingin langsung diputar:_\n\nContoh: \`XXL - Lany\``, {
            parse_mode: "Markdown", reply_markup: { force_reply: true }
          });
          break;
        case "browser_mode_youtube":
          browserSearchMode.set(msg.chat.id, { mode: "youtube", ts: Date.now() });
          await reply(bot, msg, `▶️🎥 *PUTAR DI YOUTUBE*\n══════════════════\n_Ketik judul lagu/video yang ingin langsung diputar:_\n\nContoh: \`Lany - XXL\``, {
            parse_mode: "Markdown", reply_markup: { force_reply: true }
          });
          break;
        case "browser_mode_github":
          browserSearchMode.set(msg.chat.id, { mode: "github", ts: Date.now() });
          await reply(bot, msg, `🐙 *CARI DI GITHUB*\n══════════════════\n_Ketik repository atau topik yang ingin kamu cari di GitHub:_`, {
            reply_markup: { force_reply: true }
          });
          break;
        case "browser_mode_url":
          browserSearchMode.set(msg.chat.id, { mode: "url", ts: Date.now() });
          await reply(bot, msg, `🌐 *BUKA URL*\n══════════════════\n_Ketik alamat URL:_`, {
            reply_markup: { force_reply: true }
          });
          break;
        case "browser_open_shorts": {
          await reply(bot, msg, `📱 _Membuka YouTube Shorts..._`, { parse_mode: "Markdown" });
          await runPowerShell(`
            try {
              Add-Type -TypeDefinition @"
              using System;
              using System.Runtime.InteropServices;
              public class BrowserRestoreShorts {
                  [DllImport("user32.dll")]
                  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                  [DllImport("user32.dll")]
                  public static extern bool SetForegroundWindow(IntPtr hWnd);
              }
"@
            } catch {}
            $proc = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'chrome|msedge|brave|firefox|opera') } | Select-Object -First 1
            if ($proc) {
                [BrowserRestoreShorts]::ShowWindow($proc.MainWindowHandle, 9)
                [BrowserRestoreShorts]::SetForegroundWindow($proc.MainWindowHandle)
            }
            Start-Process "https://www.youtube.com/shorts"
          `);
          await reply(bot, msg, `✅ *YouTube Shorts*\n_Gunakan ⬇️⬆️ untuk scroll video!_`, { parse_mode: "Markdown", ...mediaControlKeyboard() });
          break;
        }
        case "browser_open_tiktok": {
          await reply(bot, msg, `🎵 _Membuka TikTok..._`, { parse_mode: "Markdown" });
          await runPowerShell(`
            try {
              Add-Type -TypeDefinition @"
              using System;
              using System.Runtime.InteropServices;
              public class BrowserRestoreTikTok {
                  [DllImport("user32.dll")]
                  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                  [DllImport("user32.dll")]
                  public static extern bool SetForegroundWindow(IntPtr hWnd);
              }
"@
            } catch {}
            $proc = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'chrome|msedge|brave|firefox|opera') } | Select-Object -First 1
            if ($proc) {
                [BrowserRestoreTikTok]::ShowWindow($proc.MainWindowHandle, 9)
                [BrowserRestoreTikTok]::SetForegroundWindow($proc.MainWindowHandle)
            }
            Start-Process "https://www.tiktok.com/foryou"
          `);
          await reply(bot, msg, `✅ *TikTok For You*\n_Gunakan ⬇️⬆️ untuk scroll video!_`, { parse_mode: "Markdown", ...mediaControlKeyboard() });
          break;
        }
        case "browser_open_reels": {
          await reply(bot, msg, `📸 _Membuka Instagram Reels..._`, { parse_mode: "Markdown" });
          await runPowerShell(`
            try {
              Add-Type -TypeDefinition @"
              using System;
              using System.Runtime.InteropServices;
              public class BrowserRestoreReels {
                  [DllImport("user32.dll")]
                  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                  [DllImport("user32.dll")]
                  public static extern bool SetForegroundWindow(IntPtr hWnd);
              }
"@
            } catch {}
            $proc = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'chrome|msedge|brave|firefox|opera') } | Select-Object -First 1
            if ($proc) {
                [BrowserRestoreReels]::ShowWindow($proc.MainWindowHandle, 9)
                [BrowserRestoreReels]::SetForegroundWindow($proc.MainWindowHandle)
            }
            Start-Process "https://www.instagram.com/reels/"
          `);
          await reply(bot, msg, `✅ *Instagram Reels*\n_Gunakan ⬇️⬆️ untuk scroll video!_`, { parse_mode: "Markdown", ...mediaControlKeyboard() });
          break;
        }
        case "cmd_scroll_menu":
          await reply(bot, msg, [
            `📱 *SCROLL FEED*`,
            `══════════════════`,
            `_Pilih platform lalu scroll dari HP!_`
          ].join("\n"), { parse_mode: "Markdown", ...mediaControlKeyboard() });
          break;
        case "cmd_fullscreen":
          await runPowerShell(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('{F11}')`);
          await bot.answerCallbackQuery(query.id, { text: "🖥 Fullscreen Toggled" }).catch(() => {});
          break;
        case "cmd_browser_menu":
        case "cmd_media_panel":
          await reply(bot, msg, [
            `🎛 *MEDIA & BROWSER CONTROL*`,
            `══════════════════`,
            `_Cari, putar, dan kontrol media di laptopmu!_`
          ].join("\n"), { parse_mode: "Markdown", ...mediaControlKeyboard() });
          break;
        case "cmd_main_menu":
          await handleStartV2(bot, msg);
          break;
        case "confirm_edit":
          await handleConfirmEdit(bot, msg);
          break;
        case "cancel_edit":
          await handleCancelEdit(bot, msg);
          break;
        case "confirm_delete":
          await handleConfirmDelete(bot, msg);
          break;
        case "cancel_delete":
          await handleCancelDelete(bot, msg);
          break;
        case "run_build":
          await handleRun(bot, msg, "npm run build");
          break;
        case "rollback_last":
          await handleRollback(bot, msg, "");
          break;
        case "cmd_dev":
          await handleRun(bot, msg, "npm run dev");
          break;
        case "cmd_stop":
          await handleStop(bot, msg, "dev-server");
          break;
        case "cmd_stop_all":
          await handleStop(bot, msg, "all");
          break;
        case "cmd_terminal":
          await handleTerminalToggle(bot, msg);
          break;
        case "cmd_tree":
          await handleTree(bot, msg);
          break;
        case "cmd_dashboard_visual":
          await handleVisualDashboard(bot, msg);
          break;
        case "cmd_ai_project_chat":
          await reply(bot, msg, [
            header("AI project chat", "ask anything about your code", { icon: "✦" }),
            `_O-W-O paham struktur & isi project aktifmu._`,
            "",
            "*Contoh*",
            `${T.bullet} _"Bagaimana arsitektur folder ini?"_`,
            `${T.bullet} _"Di mana config database berada?"_`,
            `${T.bullet} _"Jelaskan alur jalannya aplikasi"_`,
            "",
            `_Ketik pertanyaan langsung tanpa command._`
          ].join("\n"), { parse_mode: "Markdown" });
          break;
        case "cmd_agent_help":
          await reply(bot, msg, [
            header("Agent mode", "tool-calling autonomous", { icon: T.agent }),
            `_AI yang eksplor, edit, dan verify project secara otonom._`,
            "",
            "*Cara pakai*",
            `${T.bullet} \`/agent <instruksi>\``,
            `${T.bullet} natural: \`agent: <instruksi>\``,
            "",
            "*Contoh*",
            `${T.bullet} \`/agent tambahkan dark mode toggle\``,
            `${T.bullet} \`/agent halaman About dengan animasi fade\``,
            `${T.bullet} \`/agent refactor src/auth pakai zod\``,
            `${T.bullet} \`/agent fix semua warning eslint\``,
            "",
            "*Tools*",
            `▤ list_dir  ·  ▦ read_file  ·  ⌕ search`,
            `⌥ apply_diff  ·  ✎ write_file  ·  ⚡ run_command`,
            "",
            "*Kontrol*",
            `${T.bullet} \`/cancel\` — stop agent`,
            `${T.bullet} \`/retry\` — ulangi prompt terakhir`,
            `${T.bullet} \`/initagent\` — generate AGENT.md`
          ].join("\n"), { parse_mode: "Markdown", ...remoteCodingKeyboard() });
          break;
        case "cmd_retry_last": {
          const last = lastUserRequest.get(String(msg.from?.id));
          if (!last) {
            await reply(bot, msg, "_Belum ada permintaan AI yang bisa di-retry._", { parse_mode: "Markdown" });
            break;
          }
          await reply(bot, msg, `↻ _Retry:_ \`${truncMid(last.text, 80)}\``, { parse_mode: "Markdown" });
          if (last.kind === "agent") {
            await runToolAgent(bot, msg, last.text);
          } else {
            msg.text = last.text;
            await handleNaturalLanguage(bot, msg);
          }
          break;
        }
        case "cmd_history":
          await handleHistory(bot, msg);
          break;
        case "cmd_briefing":
          await handleBriefing(bot, msg);
          break;
        case "cmd_git_menu":
          await handleGitMenu(bot, msg);
          break;
        case "cmd_git_add":
          await handleRun(bot, msg, "git add . && git status -s");
          break;
        case "cmd_git_commit":
          await handleGitCommitWithAi(bot, msg);
          break;
        case "cmd_pc_lock":
          await handlePCControl(bot, msg, "lock");
          break;
        case "cmd_pc_power_menu":
          await handlePowerMenu(bot, msg);
          break;
        case "cmd_pc_media_menu":
          await handleMediaMenu(bot, msg);
          break;
        case "cmd_spotify_play_top":
          {
            const playTopScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@

$allProcs = Get-Process -Name "Spotify" -ErrorAction SilentlyContinue
$proc = $allProcs | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
if (-not $proc) {
    Start-Process "spotify:"
    for ($i = 0; $i -lt 20; $i++) {
        $proc = Get-Process -Name "Spotify" -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
        if ($proc) { break }
        Start-Sleep -Milliseconds 500
    }
}

if ($proc) {
    if ([WinApi]::IsIconic($proc.MainWindowHandle)) {
        [WinApi]::ShowWindow($proc.MainWindowHandle, 9)
    } else {
        [WinApi]::ShowWindow($proc.MainWindowHandle, 5)
    }
    [WinApi]::SetForegroundWindow($proc.MainWindowHandle)
} else {
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.AppActivate("Spotify")
}

Start-Sleep -Milliseconds 600
$wshell = New-Object -ComObject WScript.Shell

$wshell.SendKeys('^l')
Start-Sleep -Milliseconds 250
$wshell.SendKeys('{ENTER}')
Start-Sleep -Milliseconds 600
$wshell.SendKeys('{DOWN}')
Start-Sleep -Milliseconds 200
$wshell.SendKeys('{DOWN}')
Start-Sleep -Milliseconds 200
$wshell.SendKeys('{ENTER}')
`;
            const playRes = await runPowerShell(playTopScript);
            if (playRes.ok) {
              await bot.answerCallbackQuery(query.id, { text: "Memutar Lagu Teratas!" }).catch(() => {});
            } else {
              await bot.answerCallbackQuery(query.id, { text: "Gagal memutar lagu teratas." }).catch(() => {});
            }
          }
          break;
        case "cmd_media_mute":
          await adjustVolume("mute");
          await bot.answerCallbackQuery(query.id, { text: "Mute / Unmute" }).catch(() => {});
          break;
        case "cmd_media_voldown":
          await adjustVolume("down");
          await bot.answerCallbackQuery(query.id, { text: "Volume Down" }).catch(() => {});
          break;
        case "cmd_media_volup":
          await adjustVolume("up");
          await bot.answerCallbackQuery(query.id, { text: "Volume Up" }).catch(() => {});
          break;
        case "cmd_media_play":
          await controlMedia("playpause");
          await bot.answerCallbackQuery(query.id, { text: "Play / Pause" }).catch(() => {});
          break;
        case "cmd_media_next":
          await controlMedia("next");
          await bot.answerCallbackQuery(query.id, { text: "Next Track" }).catch(() => {});
          break;
        case "cmd_media_prev":
          await controlMedia("prev");
          await bot.answerCallbackQuery(query.id, { text: "Previous Track" }).catch(() => {});
          break;
        case "cmd_mouse_panel":
          await reply(bot, msg, [
            `🖱️ *MOUSE CONTROL*`,
            `══════════════════`,
            `_Gunakan tombol di bawah untuk menggerakkan mouse laptopmu!_`
          ].join("\n"), { parse_mode: "Markdown", ...mouseControlKeyboard() });
          break;
        case "cmd_mouse_click":
          await runPowerShell(`Add-Type @"\nusing System.Runtime.InteropServices;\npublic class C { [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e); }\n"@\n[C]::mouse_event(2,0,0,0,0)\n[C]::mouse_event(4,0,0,0,0)`);
          await bot.answerCallbackQuery(query.id, { text: "🖱 Clicked!" }).catch(() => {});
          break;
        case "cmd_mouse_u": await handleMouseMove(bot, query.id, 0, -100); break;
        case "cmd_mouse_d": await handleMouseMove(bot, query.id, 0, 100); break;
        case "cmd_mouse_l": await handleMouseMove(bot, query.id, -100, 0); break;
        case "cmd_mouse_r": await handleMouseMove(bot, query.id, 100, 0); break;
        case "cmd_mouse_ul": await handleMouseMove(bot, query.id, -100, -100); break;
        case "cmd_mouse_ur": await handleMouseMove(bot, query.id, 100, -100); break;
        case "cmd_mouse_dl": await handleMouseMove(bot, query.id, -100, 100); break;
        case "cmd_mouse_dr": await handleMouseMove(bot, query.id, 100, 100); break;
        case "cmd_browser_close_tab":
          await runPowerShell(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('^w')`);
          await bot.answerCallbackQuery(query.id, { text: "❌ Tab Ditutup!" }).catch(() => {});
          break;
        case "cmd_pc_minimize":
          {
            const res = await runPowerShell(`
              try {
                Add-Type -TypeDefinition @"
                using System;
                using System.Runtime.InteropServices;
                public class MiniHelper {
                    [DllImport("user32.dll")]
                    public static extern IntPtr GetForegroundWindow();
                    [DllImport("user32.dll")]
                    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                }
"@
              } catch {}
              $hwnd = [MiniHelper]::GetForegroundWindow()
              if ($hwnd -ne [IntPtr]::Zero) {
                  [MiniHelper]::ShowWindow($hwnd, 6)
                  Write-Output $hwnd.ToString()
              }
            `);
            if (res.ok && res.output) {
              const val = res.output.trim();
              if (val && val !== "0") {
                lastMinimizedHwnd = val;
              }
            }
            await bot.answerCallbackQuery(query.id, { text: "🔽 Window Minimized" }).catch(() => {});
          }
          break;
        case "cmd_pc_restore":
          {
            if (lastMinimizedHwnd) {
              await runPowerShell(`
                try {
                  Add-Type -TypeDefinition @"
                  using System;
                  using System.Runtime.InteropServices;
                  public class RestoreHelper {
                      [DllImport("user32.dll")]
                      public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                      [DllImport("user32.dll")]
                      public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
                  }
"@
                } catch {}
                $hwnd = [IntPtr][long]${lastMinimizedHwnd}
                [RestoreHelper]::ShowWindow($hwnd, 9)
                [RestoreHelper]::SwitchToThisWindow($hwnd, $true)
              `);
              await bot.answerCallbackQuery(query.id, { text: "🔼 Window Restored" }).catch(() => {});
            } else {
              await runPowerShell(`
                try {
                  Add-Type -TypeDefinition @"
                  using System;
                  using System.Runtime.InteropServices;
                  public class RestoreFallbackHelper {
                      [DllImport("user32.dll")]
                      public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                      [DllImport("user32.dll")]
                      public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
                  }
"@
                } catch {}
                $proc = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'chrome|msedge|spotify|brave|firefox|opera') } | Select-Object -First 1
                if ($proc) {
                    [RestoreFallbackHelper]::ShowWindow($proc.MainWindowHandle, 9)
                    [RestoreFallbackHelper]::SwitchToThisWindow($proc.MainWindowHandle, $true)
                }
              `);
              await bot.answerCallbackQuery(query.id, { text: "🔼 Last App Restored" }).catch(() => {});
            }
          }
          break;
        case "cmd_pc_maximize":
          await runPowerShell(`
            try {
              Add-Type -TypeDefinition @"
              using System;
              using System.Runtime.InteropServices;
              public class MaxHelper {
                  [DllImport("user32.dll")]
                  public static extern IntPtr GetForegroundWindow();
                  [DllImport("user32.dll")]
                  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
              }
"@
            } catch {}
            $hwnd = [MaxHelper]::GetForegroundWindow()
            if ($hwnd -ne [IntPtr]::Zero) {
                [MaxHelper]::ShowWindow($hwnd, 3)
            }
          `);
          await bot.answerCallbackQuery(query.id, { text: "🔲 Window Maximized" }).catch(() => {});
          break;
        case "cmd_feed_pause":
          await runPowerShell(`
            try {
              Add-Type -AssemblyName System.Windows.Forms
              Add-Type -AssemblyName System.Drawing
              
              $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
              $centerX = [int]($bounds.Width / 2)
              $centerY = [int]($bounds.Height / 2)
              
              $origPos = [System.Windows.Forms.Cursor]::Position
              [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($centerX, $centerY)
              
              Add-Type -TypeDefinition @"
              using System.Runtime.InteropServices;
              public class CenterClickHelper {
                  [DllImport("user32.dll")]
                  public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
              }
"@
              [CenterClickHelper]::mouse_event(2, 0, 0, 0, 0)
              Start-Sleep -Milliseconds 40
              [CenterClickHelper]::mouse_event(4, 0, 0, 0, 0)
              
              Start-Sleep -Milliseconds 40
              [System.Windows.Forms.Cursor]::Position = $origPos
            } catch {}
          `);
          await bot.answerCallbackQuery(query.id, { text: "⏯ Video Paused / Played" }).catch(() => {});
          break;
        case "cmd_scroll_down":
          await runPowerShell(`
            try {
              Add-Type -TypeDefinition @"
              using System.Runtime.InteropServices;
              public class ScrollDownHelper {
                  [DllImport("user32.dll")]
                  public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
              }
"@
            } catch {}
            [ScrollDownHelper]::mouse_event(0x0800, 0, 0, -180, 0)
            $w = New-Object -ComObject WScript.Shell
            $w.SendKeys('{DOWN}')
          `);
          await bot.answerCallbackQuery(query.id, { text: "⬇️ Scroll Down" }).catch(() => {});
          break;
        case "cmd_scroll_up":
          await runPowerShell(`
            try {
              Add-Type -TypeDefinition @"
              using System.Runtime.InteropServices;
              public class ScrollUpHelper {
                  [DllImport("user32.dll")]
                  public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
              }
"@
            } catch {}
            [ScrollUpHelper]::mouse_event(0x0800, 0, 0, 180, 0)
            $w = New-Object -ComObject WScript.Shell
            $w.SendKeys('{UP}')
          `);
          await bot.answerCallbackQuery(query.id, { text: "⬆️ Scroll Up" }).catch(() => {});
          break;
        case "cmd_pc_shutdown":
          await handlePCControl(bot, msg, "shutdown");
          break;
        case "cmd_pc_restart":
          await handlePCControl(bot, msg, "restart");
          break;
        case "cmd_git_push":
          await handlePush(bot, msg);
          break;
        case "cmd_git_pull":
          await handleRun(bot, msg, "git pull");
          break;
        case "cmd_git_status":
          await handleRun(bot, msg, "git status");
          break;
        case "cmd_deploy":
          await handleRun(bot, msg, "npx vercel --prod --yes");
          break;
        case "cmd_lint":
          await handleRun(bot, msg, "npm run lint");
          break;
        case "cmd_engine":
          await handleEngine(bot, msg);
          break;
        case "cmd_remote_laptop":
          await handleRemoteLaptop(bot, msg);
          break;
        case "cmd_remote_coding":
          await handleRemoteCodingMenu(bot, msg);
          break;
        case "desktop_active_apps":
          await handleActiveDesktopApps(bot, msg);
          break;
        case "desktop_close_apps":
          await handleActiveDesktopApps(bot, msg);
          break;
        case "desktop_open_apps":
          await handleLaunchableDesktopApps(bot, msg);
          break;
        case "desktop_refresh_apps":
          await handleLaunchableDesktopApps(bot, msg, { forceRefresh: true });
          break;
        case "cmd_workspace":
          await handleWorkspace(bot, msg);
          break;
        case "cmd_projects":
          await handleProjects(bot, msg);
          break;
        case "cmd_dashboard":
          await handleDashboard(bot, msg);
          break;
        case "cmd_help":
          await bot.sendMessage(msg.chat.id, helpTextV2(), { parse_mode: "Markdown", ...getMainMenuKeyboard(listRunningProcesses().length) });
          break;
        case "cmd_run_menu":
          await handleRun(bot, msg, "");
          break;
        case "cmd_full_guide":
          await handleFullGuide(bot, msg);
          break;
        case "cmd_livelogs":
          await handleLiveLogs(bot, msg);
          break;
        case "cmd_project_tools":
          await handleProjectTools(bot, msg);
          break;
        case "cmd_verify_build": {
          await bot.answerCallbackQuery(query.id, { text: "Verifying build..." }).catch(() => {});
          await sendTyping(bot, msg.chat.id);
          const vResult = await runAutoVerifyResult(getActiveProjectDir(), msg.from.id).catch(() => null);
          if (!vResult) {
            await reply(bot, msg, [
              `⚠️ *NO VERIFY COMMAND*`,
              `══════════════════`,
              `_Project ini tidak memiliki check/build/lint/test script._`,
              `_Tambahkan_ \`check\`, \`build\`, \`lint\`, _atau_ \`test\` _di package.json scripts._`
            ].join("\n"), { parse_mode: "Markdown", ...remoteCodingKeyboard() });
          } else {
            await reply(bot, msg, [
              vResult.ok ? `✅ *BUILD PASSED*` : `❌ *BUILD FAILED*`,
              `══════════════════`,
              `⌨️ \`${vResult.command}\``,
              ``,
              `\`\`\`\n${truncateOutput(vResult.output || "(no output)", 2000)}\n\`\`\``
            ].join("\n"), { parse_mode: "Markdown", ...rollbackKeyboard() });
          }
          break;
        }
        case "cmd_recent_projects":
          await handleRecentProjects(bot, msg);
          break;
        case "cmd_pinned_projects":
          await handlePinnedProjects(bot, msg);
          break;
        case "cmd_port_tools":
          await handlePortTools(bot, msg);
          break;
        case "cmd_log_center":
          await handleLogCenter(bot, msg);
          break;
        case "cmd_safe_mode":
          await handleSafeMode(bot, msg);
          break;
        case "desktop_screenshot":
          await handleLaptopScreenshot(bot, msg);
          break;
        case "logs_command":
          await handleLogs(bot, msg);
          break;
        case "logs_bot":
          await handleBotLogs(bot, msg);
          break;
        case "logs_dev":
          await handleLiveLogs(bot, msg);
          break;
        case "safe_mode_on":
          await setLast("safeMode", true);
          await handleSafeMode(bot, msg);
          break;
        case "safe_mode_off":
          await setLast("safeMode", false);
          await handleSafeMode(bot, msg);
          break;
        case "safe_cancel":
          await reply(bot, msg, "Aksi dibatalkan.");
          break;
        case "noop":
          break;
        case "fix_last_error":
          await handleFix(bot, msg, "");
          break;
        default:
          if (query.data.startsWith("cmd_spotify_play_top")) {
            const queryPart = query.data.replace("cmd_spotify_play_top", "");
            const songQuery = queryPart.startsWith("_") ? decodeURIComponent(queryPart.slice(1)) : "";
            
            await bot.answerCallbackQuery(query.id, { text: songQuery ? `Mencari & Memutar ${songQuery}...` : "Memutar Lagu Teratas!" }).catch(() => {});
            
            const cleanSongQuery = (songQuery || "Lagu Teratas").replace(/"/g, '`"').replace(/\$/g, '`$');
            
            const playTopScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@

$allProcs = Get-Process -Name "Spotify" -ErrorAction SilentlyContinue
$proc = $allProcs | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
if (-not $proc) {
    Start-Process "spotify:"
    for ($i = 0; $i -lt 20; $i++) {
        $proc = Get-Process -Name "Spotify" -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
        if ($proc) { break }
        Start-Sleep -Milliseconds 500
    }
}

if ($proc) {
    if ([WinApi]::IsIconic($proc.MainWindowHandle)) {
        [WinApi]::ShowWindow($proc.MainWindowHandle, 9)
    } else {
        [WinApi]::ShowWindow($proc.MainWindowHandle, 5)
    }
    [WinApi]::SetForegroundWindow($proc.MainWindowHandle)
} else {
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.AppActivate("Spotify")
}

Start-Sleep -Milliseconds 600
$wshell = New-Object -ComObject WScript.Shell

# Focus the Search Box
$wshell.SendKeys('^l')
Start-Sleep -Milliseconds 250

# Clear old query
$wshell.SendKeys('^a')
Start-Sleep -Milliseconds 150
$wshell.SendKeys('{BACKSPACE}')
Start-Sleep -Milliseconds 150

# Type search query
$songQuery = "${cleanSongQuery}"
$escapedQuery = ""
foreach ($char in $songQuery.ToCharArray()) {
    $c = [string]$char
    if ("+^%~(){}".Contains($c)) {
        $escapedQuery += "{$c}"
    } else {
        $escapedQuery += $c
    }
}
$wshell.SendKeys($escapedQuery)
Start-Sleep -Milliseconds 300

# Search & Play first result
$wshell.SendKeys('{ENTER}')
Start-Sleep -Milliseconds 800
$wshell.SendKeys('{DOWN}')
Start-Sleep -Milliseconds 200
$wshell.SendKeys('{DOWN}')
Start-Sleep -Milliseconds 200
$wshell.SendKeys('{ENTER}')
`;
            await runPowerShell(playTopScript);
            break;
          }

          if (query.data.startsWith("switch_ws_")) {
            const drive = query.data.replace("switch_ws_", "").slice(0, 1).toUpperCase();
            if (!["C", "D"].includes(drive)) throw new Error("Drive workspace tidak dikenal.");
            await bot.answerCallbackQuery(query.id, { text: `Membuka workspace ${drive}:/...` }).catch(() => {});
            await handleSetWorkspacePath(bot, msg, `${drive}:\\`);
            break;
          }

          if (query.data.startsWith("folder_browse_")) {
            const token = query.data.replace("folder_browse_", "");
            const selection = folderSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Pilihan folder sudah expired. Buka /workspace lagi." }).catch(() => {});
              return;
            }
            await bot.answerCallbackQuery(query.id, { text: "Membuka isi folder..." }).catch(() => {});
            await handleBrowseFolder(bot, msg, selection.path);
            break;
          }

          if (query.data.startsWith("folder_workspace_")) {
            const token = query.data.replace("folder_workspace_", "");
            const selection = folderSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Pilihan folder sudah expired. Buka /workspace lagi." }).catch(() => {});
              return;
            }
            await bot.answerCallbackQuery(query.id, { text: "Mengganti workspace..." }).catch(() => {});
            await handleSetWorkspacePath(bot, msg, selection.path);
            break;
          }

          if (query.data.startsWith("folder_activate_")) {
            const token = query.data.replace("folder_activate_", "");
            const selection = folderSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Pilihan folder sudah expired. Buka /workspace lagi." }).catch(() => {});
              return;
            }
            await bot.answerCallbackQuery(query.id, { text: "Mengaktifkan project..." }).catch(() => {});
            await activateFolderAsProject(bot, msg, selection.path);
            break;
          }

          if (query.data.startsWith("folder_antigravity_")) {
            const token = query.data.replace("folder_antigravity_", "");
            const selection = folderSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Pilihan folder sudah expired. Buka /workspace lagi." }).catch(() => {});
              return;
            }
            await bot.answerCallbackQuery(query.id, { text: "Membuka IDE..." }).catch(() => {});
            await openFolderInAntigravityExplicit(bot, msg, selection.path);
            break;
          }

          if (query.data.startsWith("folder_terminal_")) {
            const token = query.data.replace("folder_terminal_", "");
            const selection = folderSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Pilihan folder sudah expired." }).catch(() => {});
              return;
            }
            const targetPath = path.resolve(selection.path);
            await bot.answerCallbackQuery(query.id, { text: `Membuka terminal di ${path.basename(targetPath)}...` }).catch(() => {});
            spawn("cmd", ["/k", `cd /d ${targetPath}`], { shell: true, detached: true, stdio: "ignore" }).unref();
            await reply(bot, msg, [
              `🖥 *TERMINAL OPENED*`,
              `══════════════════`,
              `📂 \`${targetPath}\``,
              ``,
              `_CMD dibuka di folder ini._`
            ].join("\n"), { parse_mode: "Markdown" });
            break;
          }

          if (query.data.startsWith("folder_pin_")) {
            const token = query.data.replace("folder_pin_", "");
            const selection = folderSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Pilihan project sudah expired." }).catch(() => {});
              return;
            }
            const pinned = await togglePinnedProject(selection.path);
            await bot.answerCallbackQuery(query.id, { text: pinned ? "Project dipin." : "Pin project dihapus." }).catch(() => {});
            await handleProjectTools(bot, msg);
            break;
          }

          if (query.data.startsWith("browser_url_")) {
            const browserName = decodeURIComponent(query.data.replace("browser_url_", ""));
            await bot.answerCallbackQuery(query.id, { text: "Ketik URL..." }).catch(() => {});
            browserUrlMode.set(msg.chat.id, { browser: browserName, ts: Date.now() });
            await reply(bot, msg, [
              `🌐 *OPEN URL*`,
              `══════════════════`,
              `💻 Browser: \`${browserName}\``,
              ``,
              `_Ketik URL yang ingin dibuka:_`,
              `_Contoh:_ \`youtube.com\` _atau_ \`https://github.com\``
            ].join("\n"), { parse_mode: "Markdown" });
            break;
          }

          if (query.data.startsWith("kill_port_")) {
            const port = query.data.replace("kill_port_", "");
            await bot.answerCallbackQuery(query.id, { text: `Kill port ${port}...` }).catch(() => {});
            await handleKillPort(bot, msg, port);
            break;
          }

          if (query.data.startsWith("safe_confirm_")) {
            const token = query.data.replace("safe_confirm_", "");
            const selection = safeActionSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Konfirmasi expired." }).catch(() => {});
              return;
            }
            safeActionSelections.delete(token);
            await bot.answerCallbackQuery(query.id, { text: "Menjalankan aksi..." }).catch(() => {});
            if (selection.kind === "open_antigravity") {
              await executeOpenAntigravity(bot, msg, selection.payload.path);
            } else if (selection.kind === "pc_control") {
              await handlePCControl(bot, msg, selection.payload.action, { skipSafe: true });
            }
            break;
          }

          if (query.data.startsWith("switch_proj_pick_")) {
            const token = query.data.replace("switch_proj_pick_", "");
            const selection = projectSelections.get(token);
            if (!selection) {
              await bot.answerCallbackQuery(query.id, { text: "Pilihan project sudah expired. Buka /projects lagi." }).catch(() => {});
              return;
            }

            projectSelections.delete(token);
            await bot.answerCallbackQuery(query.id, { text: `Berpindah ke ${selection.name}...` }).catch(() => {});
            await handleSwitch(bot, msg, selection.name);
            break;
          }

          if (query.data.startsWith("desktop_switch_")) {
            const token = query.data.replace("desktop_switch_", "");
            await bot.answerCallbackQuery(query.id, { text: "Berpindah jendela..." }).catch(() => {});
            await handleSwitchDesktopApp(bot, msg, token);
            break;
          }

          if (query.data.startsWith("desktop_close_")) {
            const token = query.data.replace("desktop_close_", "");
            await bot.answerCallbackQuery(query.id, { text: "Butuh konfirmasi..." }).catch(() => {});
            await handleCloseDesktopApp(bot, msg, token);
            break;
          }

          if (query.data.startsWith("desktop_confirmclose_")) {
            const token = query.data.replace("desktop_confirmclose_", "");
            await bot.answerCallbackQuery(query.id, { text: "Menutup aplikasi..." }).catch(() => {});
            await handleConfirmCloseDesktopApp(bot, msg, token);
            break;
          }

          if (query.data === "desktop_cancel_close") {
            await bot.answerCallbackQuery(query.id, { text: "Dibatalkan." }).catch(() => {});
            await handleActiveDesktopApps(bot, msg);
            break;
          }

          if (query.data.startsWith("desktop_open_")) {
            const token = query.data.replace("desktop_open_", "");
            await bot.answerCallbackQuery(query.id, { text: "Membuka aplikasi..." }).catch(() => {});
            await handleOpenDesktopApp(bot, msg, token);
            break;
          }

          if (query.data.startsWith("cmd_tunnel_")) {
            const port = query.data.replace("cmd_tunnel_", "");
            await bot.answerCallbackQuery(query.id, { text: `Membuka tunnel di port ${port}...` }).catch(() => {});
            await handleTunnel(bot, msg, port);
            break;
          }

          if (query.data.startsWith("run_cmd_")) {
            const targetCmd = query.data.replace("run_cmd_", "");
            await bot.answerCallbackQuery(query.id, { text: `Menjalankan: ${targetCmd}...` }).catch(() => {});
            await handleRun(bot, msg, targetCmd);
            break;
          }

          if (query.data.startsWith("engine_custom_")) {
            const provider = query.data.replace("engine_custom_", "");
            engineCustomMode.set(msg.chat.id, { provider, ts: Date.now() });
            await reply(bot, msg, [
              `⚙️ *CUSTOM MODEL*`,
              `══════════════════`,
              `_Provider:_ \`${provider}\``,
              ``,
              `_Ketik nama model yang ingin dipakai._`,
              `_Contoh:_`,
              `\`gemini-2.5-pro\` _(Gemini, Recommended)_`,
              `\`gemini-2.5-flash\` _(Gemini fast)_`,
              `\`qwen3-coder-next\` _(Kiro coding)_`,
              `\`claude-opus-4.7\` _(Kiro premium)_`
            ].join("\n"), { parse_mode: "Markdown", reply_markup: { force_reply: true } });
            break;
          }

          if (query.data.startsWith("engine_pick_")) {
            const payload = query.data.replace("engine_pick_", "");
            let provider, model;

            // New format: short id (e.g. "m42") that maps to { provider, model }
            // via engineModelRegistry. Fallback ke old format "provider::model"
            // untuk button yang dibuat sebelum registry restart.
            if (/^m\d+$/.test(payload)) {
              const resolved = resolveEngineModel(payload);
              if (!resolved) {
                await bot.answerCallbackQuery(query.id, {
                  text: "Tombol kadaluwarsa. Buka ulang /engine.",
                  show_alert: true
                }).catch(() => {});
                break;
              }
              provider = resolved.provider;
              model = resolved.model;
            } else {
              const sep = payload.indexOf("::");
              if (sep < 0) {
                await bot.answerCallbackQuery(query.id, { text: "Format engine tidak valid." }).catch(() => {});
                break;
              }
              provider = payload.slice(0, sep);
              model = payload.slice(sep + 2);
            }

            await setAiProvider(provider, model);
            printTerminalBanner();
            const providerLabels = {
              "gemini-apikey": "Gemini API Key",
              "kiro-apikey": "Kiro API Key"
            };
            const providerEmojis = {
              "gemini-apikey": "☁️",
              "kiro-apikey": "🧠"
            };
            await bot.sendMessage(msg.chat.id, [
              `⚙️ *Engine Switched*`,
              `══════════════════`,
              `${providerEmojis[provider] || "🤖"} *Provider:* \`${providerLabels[provider] || provider.toUpperCase()}\``,
              `🧬 *Model:* \`${model}\``,
              ``,
              `_Semua request AI sekarang lewat ${providerLabels[provider] || provider}._`
            ].join("\n"), { parse_mode: "Markdown" });
            break;
          }

          // Backward compatibility: old engine_claudecli_* / engine_codex_* / engine_gemini_* buttons.
          // Semua provider lama dimigrasi ke Gemini/Kiro API key mode.
          if (
            query.data.startsWith("engine_claudecli_") ||
            query.data.startsWith("engine_codex_") ||
            query.data.startsWith("engine_gemini_")
          ) {
            const model = query.data.replace(/^engine_(claudecli|codex|gemini)_/, "");
            const migrateToGemini = /^gemini/i.test(model) || /^gpt|^o[0-9]/i.test(model);
            const provider = migrateToGemini ? "gemini-apikey" : "kiro-apikey";
            const fallbackModel = migrateToGemini
              ? "gemini-2.5-pro"
              : "claude-opus-4.7";
            await setAiProvider(provider, fallbackModel);
            printTerminalBanner();
            await bot.sendMessage(msg.chat.id, [
              `⚙️ *Engine Switched*`,
              `══════════════════`,
              `🤖 *Provider:* \`${provider}\``,
              `🧬 *Model:* \`${fallbackModel}\``,
              ``,
              `_Migrasi otomatis dari provider lama ke mode Gemini/Kiro._`
            ].join("\n"), { parse_mode: "Markdown" });
            break;
          }
          await bot.answerCallbackQuery(query.id, { text: "Action tidak dikenal." }).catch(() => {});
          return;
      }

      await bot.answerCallbackQuery(query.id, { text: "Diproses." }).catch(() => {});
    } catch (error) {
      await logger.error("Callback handler error", { error: error.message, stack: error.stack });
      await bot.answerCallbackQuery(query.id, { text: "Terjadi kesalahan." }).catch(() => {});
      if (msg) {
        await reply(bot, msg, formatGlobalError(error.message), { parse_mode: "Markdown" }).catch(() => {});
      }
    }
  });

  bot.on("message", async (msg) => {
    try {
      const text = msg.text || msg.caption || "";
      if (!(await requireAdmin(bot, msg))) return;
      if (!text && !msg.photo && !msg.voice) return;
      await syncActiveSession();

      // Only essential slash commands
      if (text.startsWith("/")) {
        const { command, args } = getCommandParts(text);
        switch (command) {
          case "/start":
            await handleStartV2(bot, msg);
            return;
          case "/clear":
            await clearConversationHistory();
            await clearSessionData({ preserveActivePaths: true });
            await bot.sendMessage(msg.chat.id, "·\n".repeat(80) + "·");
            await reply(bot, msg, `🧹 *CHAT & CONVERSATION CLEARED*\n══════════════════\n_Memori obrolan A.I. telah di-reset sepenuhnya. Layar chat telah dibersihkan secara visual._\n\n_Silakan ketik atau kirim perintah baru untuk memulai dari awal!_`, { parse_mode: "Markdown", ...getMainMenuKeyboard(listRunningProcesses().length) });
            return;
          case "/help":
            await bot.sendMessage(msg.chat.id, helpTextV2(), { parse_mode: "Markdown", ...getMainMenuKeyboard(listRunningProcesses().length) });
            return;
          case "/laptop":
            await handleRemoteLaptop(bot, msg);
            return;
          case "/coding":
            await handleRemoteCodingMenu(bot, msg);
            return;
          case "/apps":
            await handleActiveDesktopApps(bot, msg);
            return;
          case "/screenshot":
            await handleLaptopScreenshot(bot, msg);
            return;
          case "/url": {
            if (!args) {
              await reply(bot, msg, [
                `🌐 *OPEN URL*`,
                `══════════════════`,
                `_Format:_`,
                `\`/url youtube.com\` → browser default`,
                `\`/url brave github.com\` → browser spesifik`,
              ].join("\n"), { parse_mode: "Markdown" });
              return;
            }
            const parts = args.split(/\s+/);
            const browserExe = detectBrowserExe(parts[0]);
            const targetUrl = browserExe ? parts.slice(1).join(" ") : args;
            const browserLabel = browserExe ? parts[0] : null;
            if (!targetUrl) {
              await reply(bot, msg, `⚠️ _URL kosong. Contoh:_ \`/url youtube.com\``, { parse_mode: "Markdown" });
              return;
            }
            const urlRes = await openUrl(targetUrl, browserLabel);
            await reply(bot, msg, urlRes.ok
              ? [`✅ *URL OPENED*`, `══════════════════`, `🌐 \`${urlRes.detail?.url || targetUrl}\``, browserLabel ? `💻 \`${browserLabel}\`` : ``].filter(Boolean).join("\n")
              : `❌ *Gagal membuka URL*\n${urlRes.output}`,
              { parse_mode: "Markdown" });
            return;
          }
          case "/findproject":
            await handleFindProject(bot, msg, args);
            return;
          case "/projecttools":
            await handleProjectTools(bot, msg);
            return;
          case "/ports":
            await handlePortTools(bot, msg);
            return;
          case "/logcenter":
            await handleLogCenter(bot, msg);
            return;
          case "/safemode":
            await handleSafeMode(bot, msg);
            return;
          case "/projects":
            await handleProjects(bot, msg);
            return;
          case "/select":
            await handleSelectProject(bot, msg);
            return;
          case "/open":
            await handleOpenApp(bot, msg, args);
            return;
          case "/close":
            await handleCloseApp(bot, msg, args);
            return;
          case "/dashboard":
            await handleDashboard(bot, msg);
            return;
          case "/deploy":
            await handleRun(bot, msg, "npx vercel --prod --yes");
            return;
          case "/push":
            await handlePush(bot, msg);
            return;
          case "/engine":
            await handleEngine(bot, msg);
            return;
          case "/sync":
            await handleSyncState(bot, msg);
            return;
          case "/format":
            await handleFormat(bot, msg);
            return;
          case "/outline":
            await handleOutline(bot, msg, args);
            return;
          case "/logs":
            await handleLogs(bot, msg);
            return;
          case "/livelogs":
            await handleLiveLogs(bot, msg);
            return;
          case "/run":
            await handleRun(bot, msg, args);
            return;
          case "/agent": {
            if (!args || !args.trim()) {
              await reply(bot, msg, [
                header("Agent mode", "tool-calling autonomous", { icon: T.agent }),
                "*Format*",
                `${T.bullet} \`/agent <instruksi>\``,
                `${T.bullet} natural: \`agent: <instruksi>\``,
                "",
                "*Contoh*",
                `${T.bullet} \`/agent tambah dark mode toggle\``,
                `${T.bullet} \`/agent halaman About dengan animasi\``,
                `${T.bullet} \`/agent refactor src/auth pakai zod\``,
                "",
                "*Kontrol*",
                `${T.bullet} \`/cancel\` — stop`,
                `${T.bullet} \`/retry\` — ulangi`,
                `${T.bullet} \`/initagent\` — bikin AGENT.md`
              ].join("\n"), { parse_mode: "Markdown" });
              return;
            }
            await runToolAgent(bot, msg, args);
            return;
          }
          case "/cancel": {
            const session = activeAgentSessions.get(msg.chat.id);
            if (!session) {
              await reply(bot, msg, "_Tidak ada agent yang sedang berjalan._", { parse_mode: "Markdown" });
              return;
            }
            try { session.abort.abort(); } catch {}
            activeAgentSessions.delete(msg.chat.id);
            await reply(bot, msg, [
              header("Cancel requested", "", { icon: "■" }),
              `Agent \`${truncMid(session.label, 50)}\` _akan berhenti di step berikutnya._`
            ].join("\n"), { parse_mode: "Markdown" });
            return;
          }
          case "/retry": {
            const last = lastUserRequest.get(String(msg.from?.id));
            if (!last) {
              await reply(bot, msg, "_Belum ada permintaan AI yang bisa di-retry._", { parse_mode: "Markdown" });
              return;
            }
            await reply(bot, msg, `🔁 _Retry:_ \`${truncateOutput(last.text, 80)}\``, { parse_mode: "Markdown" });
            if (last.kind === "agent") {
              await runToolAgent(bot, msg, last.text);
            } else {
              msg.text = last.text;
              await handleNaturalLanguage(bot, msg);
            }
            return;
          }
          case "/ask":
            await handleAsk(bot, msg, args);
            return;
          case "/read":
            await handleRead(bot, msg, args);
            return;
          case "/write":
            await handleWrite(bot, msg, args);
            return;
          case "/download":
            await handleDownload(bot, msg, args);
            return;
          case "/zip":
            await handleZipProject(bot, msg);
            return;
          case "/tree":
          case "/files":
            await handleTree(bot, msg);
            return;
          case "/status":
            await handleStatus(bot, msg);
            return;
          case "/whoami":
            await handleWhoami(bot, msg);
            return;
          case "/health":
            await handleHealth(bot, msg);
            return;
          case "/diagnose":
          case "/diag":
            await handleDiagnose(bot, msg);
            return;
          case "/workspace":
            await handleWorkspace(bot, msg);
            return;
          case "/setworkspace":
            await handleSetWorkspace(bot, msg, args);
            return;
          case "/drives":
            await handleDrives(bot, msg);
            return;
          case "/switch":
            await handleSwitch(bot, msg, args);
            return;
          case "/edit":
            await handleEdit(bot, msg, args);
            return;
          case "/fix":
            await handleFix(bot, msg, args);
            return;
          case "/create":
            await handleCreate(bot, msg, args);
            return;
          case "/delete":
            await handleDelete(bot, msg, args);
            return;
          case "/confirmdelete":
            await handleConfirmDelete(bot, msg);
            return;
          case "/canceldelete":
            await handleCancelDelete(bot, msg);
            return;
          case "/confirm":
          case "/confirmedit":
            await handleConfirmEdit(bot, msg);
            return;
          case "/cancel":
          case "/canceledit":
            await handleCancelEdit(bot, msg);
            return;
          case "/backup":
            await handleBackup(bot, msg, args);
            return;
          case "/rollback":
            await handleRollback(bot, msg, args);
            return;
          case "/search":
            await handleSearch(bot, msg, args);
            return;
          case "/memory":
            await handleMemory(bot, msg, args);
            return;
          case "/skills":
            await handleSkills(bot, msg, args);
            return;
          case "/skill": {
            const skillArgs = String(args || "").trim();
            const match = skillArgs.match(/^save\s+(.+)$/i);
            if (!match) throw new Error("Format: /skill save <name>");
            await handleSkillSave(bot, msg, match[1]);
            return;
          }
          case "/history":
            await handleHistory(bot, msg);
            return;
          case "/briefing":
          case "/brief":
            await handleBriefing(bot, msg);
            return;
          case "/snippet":
          case "/snip":
            await handleSnippet(bot, msg, args);
            return;
          case "/initagent":
          case "/init":
            await handleInitAgent(bot, msg);
            return;
          case "/remember":
            await handleRemember(bot, msg, args);
            return;
          case "/forget":
            await handleForget(bot, msg, args);
            return;
          case "/persona":
            await handlePersona(bot, msg, args);
            return;
          case "/chat":
            await handleChatToggle(bot, msg);
            return;
          case "/quick":
          case "/q":
            await handleQuickAsk(bot, msg, args);
            return;
          case "/kill":
            await handleKillPort(bot, msg, args);
            return;
          case "/sysinfo":
            await handleSysinfo(bot, msg);
            return;
          case "/lock":
            await handlePCControl(bot, msg, "lock");
            return;
          case "/shutdown":
            await handlePCControl(bot, msg, "shutdown");
            return;
          case "/restart":
            await handlePCControl(bot, msg, "restart");
            return;
          case "/stop":
            await handleStop(bot, msg, args);
            return;
          case "/tunnel":
            await handleTunnel(bot, msg, args);
            return;
          case "/terminal":
          case "/shell":
            // /shell <powershell|cmd|bash> ganti shell preference, tanpa argumen
            // toggle terminal mode (backward-compat).
            if (text.startsWith("/shell") && args && args.trim()) {
              await handleShellSelect(bot, msg, args);
              return;
            }
            await handleTerminalToggle(bot, msg);
            return;
          case "/connectors":
            await handleConnectorsList(bot, msg);
            return;
          case "/connector":
            await handleConnectorSubcommand(bot, msg, args);
            return;
          case "/login":
            await handleLoginCommand(bot, msg, args);
            return;
          case "/approve":
            await handleApproveCommand(bot, msg, args);
            return;
          case "/reject":
            await handleRejectCommand(bot, msg, args);
            return;
          case "/approvals":
            await handleApprovals(bot, msg);
            return;
        }
        // All other slash commands: strip the / and treat as natural language
        // e.g., "/fix src/App.jsx error" → "fix src/App.jsx error"
        const naturalText = text.replace(/^\/+/, "").trim();
        if (naturalText) {
          msg.text = naturalText;
          await handleNaturalLanguage(bot, msg);
          return;
        }
      }
      // ── Browser Search mode: user typed search query after pressing a browser search button ──
      const searchSession = browserSearchMode.get(msg.chat.id);
      if (searchSession && !text.startsWith("/") && (Date.now() - searchSession.ts < 5 * 60 * 1000)) {
        browserSearchMode.delete(msg.chat.id);
        const mode = searchSession.mode;

        // ── Media sites: auto-play via mouse automation ──
        if (mode === "spotify" || mode === "youtube") {
          await reply(bot, msg, `🎶 _Membuka ${mode === "spotify" ? "Spotify Web" : "YouTube"} dan memutar:_ \`${text}\`_..._\n⏳ _Tunggu beberapa detik..._`, { parse_mode: "Markdown" });
          const playResult = await playSearchInBrowser(mode, text);
          if (playResult.ok) {
            await reply(bot, msg, [
              `✅ *NOW PLAYING*`,
              `══════════════════`,
              `🎯 *Situs:* \`${playResult.siteLabel}\``,
              `🔍 *Pencarian:* \`${text}\``,
              `══════════════════`,
              `▶️ _Lagu/video sedang diputar di browser laptopmu!_`,
              `🎛 _Gunakan tombol di bawah untuk kontrol pemutaran._`
            ].join("\n"), { parse_mode: "Markdown", ...mediaControlKeyboard() });
          } else {
            await reply(bot, msg, `❌ *Gagal memutar di ${playResult.siteLabel}*\n${playResult.output}`, { parse_mode: "Markdown", ...mediaControlKeyboard() });
          }
          return;
        }

        // ── Non-media sites: just open search URL ──
        let searchUrl = "";
        let siteLabel = "";
        switch (mode) {
          case "github":
            searchUrl = `https://github.com/search?q=${encodeURIComponent(text)}`;
            siteLabel = "GitHub 🐙";
            break;
          case "google":
            searchUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
            siteLabel = "Google 🌐";
            break;
          case "url": {
            let normalized = String(text || "").trim();
            if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
            searchUrl = normalized;
            siteLabel = "Browser 🌐";
            break;
          }
        }
        await reply(bot, msg, `🔍 _Membuka ${siteLabel}:_ \`${text}\`_..._`, { parse_mode: "Markdown" });
        const searchResult = await openUrl(searchUrl);
        if (searchResult.ok) {
          await reply(bot, msg, [
            `✅ *SEARCH COMPLETED*`,
            `══════════════════`,
            `🎯 *Situs:* \`${siteLabel}\``,
            `🔍 *Pencarian:* \`${text}\``,
            `══════════════════`,
            ` _Pencarian telah berhasil dibuka di laptopmu._`
          ].join("\n"), { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
        } else {
          await reply(bot, msg, `❌ *Gagal membuka ${siteLabel}*\n${searchResult.output}`, { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
        }
        return;
      }
      browserSearchMode.delete(msg.chat.id);

      // ── Engine custom-model input mode ──
      const customSession = engineCustomMode.get(msg.chat.id);
      if (customSession && !text.startsWith("/") && (Date.now() - customSession.ts < 5 * 60 * 1000)) {
        engineCustomMode.delete(msg.chat.id);
        let model = text.trim().replace(/[\s,;`'"]+$/g, "").replace(/^\s*[`'"]+/g, "");
        if (!model) return;
        // Validation per provider (Gemini / Kiro).
        const providerValidation = {
          "gemini-apikey": (m) => /^(google\/)?[a-z0-9_.-]+$/i.test(m),
          "kiro-apikey": (m) => /^(kiro\/)?[a-z0-9_.-]+$/i.test(m)
        };
        const validate = providerValidation[customSession.provider];
        if (validate && !validate(model)) {
          await reply(bot, msg, [
            `⚠️ *Model format invalid*`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `_Provider:_ \`${customSession.provider}\``,
            `_Input:_ \`${model}\``,
            ``,
            `_Format model bebas, contoh tanpa prefix atau pakai prefix._`,
            `_Contoh:_`,
            `\`gemini-2.5-pro\``,
            `\`gemini-2.5-flash\``,
            `\`qwen3-coder-next\``,
            ``,
            `_Coba_ \`/engine\` _lagi._`
          ].join("\n"), { parse_mode: "Markdown" });
          return;
        }
        await setAiProvider(customSession.provider, model);
        printTerminalBanner();
        await reply(bot, msg, [
          `⚙️ *Engine switched*`,
          `━━━━━━━━━━━━━━━━━━━━━━`,
          `🤖 *Provider:* \`${customSession.provider}\``,
          `🧬 *Model:* \`${model}\``,
          ``,
          `_Custom model di-set. Pakai_ \`/diagnose\` _untuk verifikasi._`
        ].join("\n"), { parse_mode: "Markdown" });
        return;
      }
      engineCustomMode.delete(msg.chat.id);

      // ── Browser URL mode: user typed a URL after pressing "Buka URL" ──
      const urlSession = browserUrlMode.get(msg.chat.id);
      if (urlSession && !text.startsWith("/") && (Date.now() - urlSession.ts < 5 * 60 * 1000)) {
        browserUrlMode.delete(msg.chat.id);
        const urlResult = await openUrl(text, urlSession.browser);
        await reply(bot, msg, urlResult.ok
          ? [`✅ *URL OPENED*`, `══════════════════`, `🌐 \`${urlResult.detail?.url || text}\``, `💻 \`${urlSession.browser}\``].join("\n")
          : `❌ *Gagal membuka URL*\n${urlResult.output}`,
          { parse_mode: "Markdown", ...remoteLaptopKeyboard() });
        return;
      }
      browserUrlMode.delete(msg.chat.id);

      await handleNaturalLanguage(bot, msg);
    } catch (error) {
      await logger.error("Command handler error", { error: error.message, stack: error.stack });
      await reply(bot, msg, formatGlobalError(error.message), { parse_mode: "Markdown" }).catch(() => {});
    }
  });
}
