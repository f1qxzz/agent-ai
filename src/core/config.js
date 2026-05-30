import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const APP_ROOT = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(APP_ROOT, ".env") });

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseAdminIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeShell(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["powershell", "ps", "pwsh"].includes(v)) return "powershell";
  if (["cmd", "command", "cmd.exe"].includes(v)) return "cmd";
  if (["bash", "git-bash", "gitbash"].includes(v)) return "bash";
  return "powershell"; // default Windows
}

function parseFallbackOrder(value) {
  return String(value || "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function parseBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeAiProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "kiro-apikey" || normalized === "kiro" || normalized === "kiro-api") {
    return "kiro-apikey";
  }
  if (normalized === "gemini-apikey" || normalized === "gemini" || normalized === "gemini-api") {
    return "gemini-apikey";
  }
  // Fallback aman: Gemini API key.
  return "gemini-apikey";
}

const defaultWorkspaceDir = path.join(APP_ROOT, "workspace");
const configuredProjectDir = process.env.PROJECT_ROOT || process.env.PROJECT_DIR || defaultWorkspaceDir;
const configuredWorkspaceDir = process.env.WORKSPACE_DIR || path.dirname(configuredProjectDir);

export const config = {
  appRoot: APP_ROOT,
  backupsDir: path.join(APP_ROOT, "backups"),
  dataDir: path.join(APP_ROOT, "data"),
  logsDir: path.join(APP_ROOT, "logs"),
  commandLogFile: path.join(APP_ROOT, "logs", "commands.log"),
  appLogFile: path.join(APP_ROOT, "logs", "app.log"),
  agentName: process.env.AGENT_NAME || "O-W-O",
  agentOwner: process.env.AGENT_OWNER || "@f1qxzz",
  agentCredentialDir: process.env.AGENT_CREDENTIAL_DIR || "~/.agent/credentials",
  requireApprovalForDestructive: parseBool(process.env.REQUIRE_APPROVAL_FOR_DESTRUCTIVE, true),
  requireApprovalForPublicPost: parseBool(process.env.REQUIRE_APPROVAL_FOR_PUBLIC_POST, true),
  requireApprovalForForcePush: parseBool(process.env.REQUIRE_APPROVAL_FOR_FORCE_PUSH, true),
  safeMode: parseBool(process.env.SAFE_MODE, true),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramUserId: process.env.TELEGRAM_USER_ID || process.env.OWNER_TELEGRAM_ID || "",
  // OWNER_TELEGRAM_ID is the canonical alias going forward; TELEGRAM_USER_ID
  // tetap dipertahankan demi backward compat. Keduanya dimerge ke admin list.
  adminUserIds: Array.from(new Set([
    ...parseAdminIds(process.env.TELEGRAM_USER_ID),
    ...parseAdminIds(process.env.OWNER_TELEGRAM_ID)
  ])),
  defaultShell: normalizeShell(process.env.DEFAULT_SHELL || (process.platform === "win32" ? "powershell" : "bash")),
  gitBashPath: process.env.GIT_BASH_PATH || "", 
  fallbackProviderOrder: parseFallbackOrder(process.env.AI_FALLBACK_ORDER),
  aiAutoFallback: String(process.env.AI_AUTO_FALLBACK || "true").toLowerCase() !== "false",
  aiProviderTimeoutMs: parseInteger(process.env.AI_PROVIDER_TIMEOUT_MS, 180000, {
    min: 10000,
    max: 30 * 60 * 1000
  }),
  kiroCliCommand: process.env.KIRO_CLI_COMMAND || "kiro-cli",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  kiroApiKey: process.env.KIRO_API_KEY || "",
  aiProvider: normalizeAiProvider(process.env.AI_PROVIDER),
  aiModel: process.env.AI_MODEL || "gemini-2.5-pro",
  projectDir: path.resolve(configuredProjectDir),
  projectRoot: path.resolve(configuredProjectDir),
  workspaceDir: path.resolve(configuredWorkspaceDir),
  commandTimeoutMs: parseInteger(process.env.COMMAND_TIMEOUT_MS, 300000, {
    min: 1000,
    max: 30 * 60 * 1000
  }),
  maxOutputChars: parseInteger(process.env.MAX_OUTPUT_CHARS, 15000, {
    min: 1000,
    max: 60000
  }),
  telegramMessageLimit: 3900,
  commandRateLimit: {
    limit: 999,
    windowMs: 60 * 1000
  },
  aiRateLimit: {
    limit: 999,
    windowMs: 5 * 60 * 1000
  },

  // ── Connector system ─────────────────────────────────
  connectorTimeoutMs: parseInteger(process.env.CONNECTOR_TIMEOUT_MS, 30000, {
    min: 3000,
    max: 5 * 60 * 1000
  }),
  connectorMaxRetries: parseInteger(process.env.CONNECTOR_MAX_RETRIES, 2, {
    min: 0,
    max: 6
  }),

  // GitHub
  enableGithubConnector: parseBool(process.env.ENABLE_GITHUB_CONNECTOR, false),
  githubToken: process.env.GITHUB_TOKEN || "",
  githubUsername: process.env.GITHUB_USERNAME || "",
  githubDefaultOwner: process.env.GITHUB_DEFAULT_OWNER || "",
  githubDefaultRepo: process.env.GITHUB_DEFAULT_REPO || "",

  // Discord
  enableDiscordConnector: parseBool(process.env.ENABLE_DISCORD_CONNECTOR, false),
  discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
  discordAllowedGuildId: process.env.DISCORD_ALLOWED_GUILD_ID || "",
  discordAllowedChannelIds: parseCsv(process.env.DISCORD_ALLOWED_CHANNEL_IDS),

  // X / Twitter
  enableXConnector: parseBool(process.env.ENABLE_X_CONNECTOR, false),
  xApiKey: process.env.X_API_KEY || "",
  xApiSecret: process.env.X_API_SECRET || "",
  xAccessToken: process.env.X_ACCESS_TOKEN || "",
  xAccessSecret: process.env.X_ACCESS_SECRET || "",
  xBearerToken: process.env.X_BEARER_TOKEN || ""
};

export async function ensureAppDirectories() {
  await Promise.all([
    fs.mkdir(config.backupsDir, { recursive: true }),
    fs.mkdir(config.dataDir, { recursive: true }),
    fs.mkdir(config.logsDir, { recursive: true }),
    fs.mkdir(path.join(config.appRoot, "workspace"), { recursive: true })
  ]);
}

export function getMissingConfigKeys() {
  const missing = [];
  if (!config.telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.telegramUserId || config.adminUserIds.length === 0) missing.push("OWNER_TELEGRAM_ID");
  // Startup tetap diizinkan selama minimal satu provider AI siap.
  // Ini memungkinkan fallback otomatis berjalan walau provider utama belum siap.
  if (!String(config.geminiApiKey || "").trim() && !String(config.kiroApiKey || "").trim()) {
    if (!missing.includes("GEMINI_API_KEY")) missing.push("GEMINI_API_KEY");
    if (!missing.includes("KIRO_API_KEY")) missing.push("KIRO_API_KEY");
  }

  return missing;
}

export function assertConfigReady() {
  const missing = getMissingConfigKeys();
  if (missing.length > 0) {
    throw new Error(`Konfigurasi belum lengkap: ${missing.join(", ")}. Salin .env.example ke .env lalu isi nilainya.`);
  }
}

export async function saveConfigToEnv(updates) {
  const envPath = path.join(APP_ROOT, ".env");
  try {
    let content = "";
    try {
      content = await fs.readFile(envPath, "utf8");
    } catch (e) {
      // .env doesn't exist, create empty
    }

    let lines = content.split(/\r?\n/);
    for (const [key, value] of Object.entries(updates)) {
      let found = false;
      lines = lines.map((line) => {
        if (line.trim().startsWith(`${key}=`)) {
          found = true;
          return `${key}=${value}`;
        }
        return line;
      });
      if (!found) {
        lines.push(`${key}=${value}`);
      }
    }
    await fs.writeFile(envPath, lines.join("\n"), "utf8");
    return true;
  } catch (error) {
    console.error("Gagal menyimpan .env:", error);
    return false;
  }
}

export async function setAiProvider(provider, model) {
  config.aiProvider = normalizeAiProvider(provider);
  if (model) config.aiModel = model;

  await saveConfigToEnv({
    AI_PROVIDER: config.aiProvider,
    AI_MODEL: config.aiModel
  });
}
