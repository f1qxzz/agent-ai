import fs from "fs";
import path from "path";
import { config } from "../core/config.js";

// ─────────────────────────────────────────────
// Sensitive file/folder definitions
// ─────────────────────────────────────────────
//
// File / nama yang harus diblokir dari operasi read/write yang dipicu oleh
// AI/agent/natural-language. Block ini berlaku untuk fileManager + tool
// agent. Shell terminal punya jalur sendiri (assertShellSafe).

const sensitiveExactNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
  ".env.test",
  ".envrc",
  "credentials.json",
  "service-account.json",
  "service_account.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".aws",
  "credentials",
  "session.json",
  "cookies.txt"
]);

const sensitiveExactNamesLower = new Set(
  Array.from(sensitiveExactNames).map((s) => s.toLowerCase())
);

const blockedExtensions = new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".cer",
  ".crt",
  ".jks",
  ".keystore"
]);

// Folder yang isi-nya tidak boleh diakses agent / AI (substring check, lowercase).
const sensitiveDirSegments = new Set([
  "credentials",
  "sessions",
  "session",
  "secrets",
  ".ssh",
  ".aws",
  ".gnupg",
  "private",
  "private_keys"
]);

// Folder dalam .git yang tidak boleh disentuh agent (read object/refs internal
// bisa membocorkan history). .gitignore / .gitattributes di project root tetap
// boleh dibaca karena tidak masuk ke folder .git/.
const sensitiveDotGitInternals = true;

const rateBuckets = new Map();

// Defense-in-depth: command tetap di-whitelist, daftar ini memblokir pola shell berbahaya lebih awal.
const dangerousCommandFragments = [
  "curl | bash",
  "curl|bash",
  "wget | bash",
  "wget|bash"
];
const shellOperators = ["&&", "||", ";", "`", "$(", "\n", "\r", "|", ">", "<"];
const allowedCommandExecutables = new Set(["npm", "npx", "pnpm", "yarn", "node", "git"]);

export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecurityError";
  }
}

export function isAdminUser(userId) {
  return config.adminUserIds.includes(String(userId));
}

export function sanitizePathInput(input) {
  const trimmed = String(input || "").trim().replace(/^["']|["']$/g, "");
  if (!trimmed) throw new SecurityError("Path file wajib diisi.");
  if (trimmed.includes("\0")) throw new SecurityError("Path file tidak valid.");
  return path.normalize(trimmed);
}

/**
 * Pastikan targetPath benar-benar berada di dalam baseDir.
 * Throw SecurityError kalau target keluar dari base (mis. via "..", symlink
 * yang sudah di-resolve via path.resolve, atau path absolut beda root).
 *
 * Return absolute target path yang sudah di-resolve.
 */
export function assertInsideBase(baseDir, targetPath) {
  if (!baseDir) throw new SecurityError("Base directory wajib diisi.");
  if (!targetPath) throw new SecurityError("Target path wajib diisi.");

  const base = path.resolve(String(baseDir));
  const target = path.resolve(String(targetPath));

  // Drive root case (Windows): target == base persis (mis. D:\PROJECT == D:\PROJECT)
  if (target === base) return target;

  const relative = path.relative(base, target);
  if (!relative || relative === "") return target;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SecurityError(
      `Akses di luar workspace ditolak. base="${base}" target="${target}"`
    );
  }
  // Cross-drive on Windows: path.relative bisa balikkan path absolut
  if (process.platform === "win32" && /^[a-zA-Z]:[\\/]/.test(relative)) {
    throw new SecurityError("Akses lintas drive ditolak.");
  }
  return target;
}

export function isPathInside(baseDir, targetPath) {
  try {
    assertInsideBase(baseDir, targetPath);
    return true;
  } catch {
    return false;
  }
}

export function resolveProjectPath(projectDir, userPath) {
  const cleaned = sanitizePathInput(userPath);
  const resolved = path.resolve(projectDir, cleaned);
  return assertInsideBase(projectDir, resolved);
}

export function resolveWorkspaceProject(workspaceDir, projectName) {
  const cleaned = String(projectName || "").trim();
  if (!cleaned) throw new SecurityError("Nama project wajib diisi.");
  if (cleaned.includes("/") || cleaned.includes("\\") || cleaned === "." || cleaned === "..") {
    throw new SecurityError("Nama project tidak boleh berupa path.");
  }
  if (isBlockedWorkspaceChildName(cleaned)) {
    throw new SecurityError("Folder sistem tidak boleh dipilih sebagai project.");
  }
  const resolved = path.resolve(workspaceDir, cleaned);
  return assertInsideBase(workspaceDir, resolved);
}

const blockedWorkspaceChildNames = new Set([]);

export function isBlockedWorkspaceChildName(name) {
  return false;
}

export function resolveWorkspacePath(input) {
  let cleaned = String(input || "").trim().replace(/^["']|["']$/g, "");
  if (!cleaned) throw new SecurityError("Path workspace wajib diisi.");
  if (cleaned.includes("\0")) throw new SecurityError("Path workspace tidak valid.");

  if (process.platform === "win32") {
    if (/^[a-zA-Z]$/.test(cleaned)) cleaned = `${cleaned}:\\`;
    if (/^[a-zA-Z]:$/.test(cleaned)) cleaned = `${cleaned}\\`;
    if (cleaned.startsWith("\\\\")) throw new SecurityError("UNC/network path tidak diizinkan untuk workspace.");
    if (!/^[a-zA-Z]:[\\/]/.test(cleaned)) {
      throw new SecurityError("Gunakan path absolut Windows, contoh: C:\\PROJECT atau D:\\PROJECT.");
    }

    const drive = cleaned.slice(0, 1).toUpperCase();
  } else if (!path.isAbsolute(cleaned)) {
    throw new SecurityError("Gunakan path workspace absolut.");
  }

  const resolved = path.resolve(cleaned);
  const baseName = path.basename(resolved).toLowerCase();
  const parsed = path.parse(resolved);
  const isDriveRoot = process.platform === "win32" && resolved.toLowerCase() === parsed.root.toLowerCase();
  if (!isDriveRoot && isBlockedWorkspaceChildName(baseName)) {
    throw new SecurityError("Folder sistem tidak boleh dijadikan workspace.");
  }

  return resolved;
}

export function isSensitivePath(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(String(filePath));
  const baseName = path.basename(resolved);
  const baseLower = baseName.toLowerCase();

  if (sensitiveExactNamesLower.has(baseLower)) return true;
  // .env.* variants we may not have enumerated explicitly
  if (/^\.env(\..+)?$/i.test(baseName)) return true;

  const ext = path.extname(baseLower);
  if (ext && blockedExtensions.has(ext)) return true;

  // Block files that LOOK like secrets by name
  if (/(^|[._-])secret(s)?($|[._-])/i.test(baseName)) return true;
  if (/(^|[._-])token($|[._-])/i.test(baseName)) return true;
  if (/(^|[._-])credential(s)?($|[._-])/i.test(baseName)) return true;
  if (/(^|[._-])private[._-]?key($|[._-])/i.test(baseName)) return true;
  if (/^cookies?\.txt$/i.test(baseName)) return true;

  // Block paths that traverse a sensitive directory segment
  const segments = resolved.split(/[\\/]+/).map((s) => s.toLowerCase()).filter(Boolean);
  for (const seg of segments) {
    if (sensitiveDirSegments.has(seg)) return true;
  }

  // .git internals (.git/objects, .git/refs, .git/HEAD, etc) — block read/write,
  // but project root .gitignore / .gitattributes / .github tetap boleh.
  if (sensitiveDotGitInternals) {
    const idx = segments.indexOf(".git");
    if (idx >= 0 && idx < segments.length - 1) return true;
  }

  return false;
}

export function assertNotSensitivePath(filePath) {
  if (isSensitivePath(filePath)) {
    throw new SecurityError(
      `Path sensitif diblokir: ${path.basename(String(filePath))}. ` +
      "File seperti .env, credentials, sessions, atau private key tidak boleh diakses lewat AI / agent."
    );
  }
}

export function redactSecrets(value) {
  let text = String(value ?? "");

  const knownSecrets = [
    config.telegramBotToken,
    config.geminiApiKey,
    config.kiroApiKey,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.KIRO_API_KEY,
    process.env.NGROK_AUTHTOKEN,
    process.env.GITHUB_TOKEN,
    process.env.GITHUB_PAT,
    process.env.DISCORD_BOT_TOKEN,
    process.env.DISCORD_TOKEN,
    process.env.X_BEARER_TOKEN,
    process.env.X_API_KEY,
    process.env.X_API_SECRET,
    process.env.X_ACCESS_TOKEN,
    process.env.X_ACCESS_SECRET
  ].filter((item) => typeof item === "string" && item.length >= 8);

  for (const secret of knownSecrets) {
    text = text.split(secret).join("[REDACTED_SECRET]");
  }

  return text
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/\bsk-or-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgsk_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_GROQ_KEY]")
    .replace(/\bksk_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KIRO_KEY]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_GEMINI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_PAT]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    // Discord bot token: <id>.<rand>.<hmac>
    .replace(/\b[MN][A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, "[REDACTED_DISCORD_TOKEN]")
    // Twitter/X bearer tokens (long opaque blobs prefixed with AAAA)
    .replace(/\bAAAA[A-Za-z0-9%]{20,}\b/g, "[REDACTED_X_BEARER]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[REDACTED_SLACK_TOKEN]")
    // Authorization: Bearer/Basic <token>
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic|token)\s+[A-Za-z0-9._\-+/=]{8,}/gi, "$1[REDACTED_AUTH]")
    // Cookie: foo=bar; sess=xyz
    .replace(/(cookie\s*[:=]\s*)[^\r\n]{8,}/gi, "$1[REDACTED_COOKIE]")
    .replace(/(["']?(?:api[_-]?key|token|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|cookie|cookies|session|session[_-]?id|session[_-]?token|private[_-]?key|mnemonic|seed[_-]?phrase|recovery[_-]?phrase)["']?\s*[:=]\s*)["'][^"']{8,}["']/gi, '$1"[REDACTED]"')
    .replace(/\b((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|COOKIE|COOKIES|SESSION|SESSION[_-]?ID|SESSION[_-]?TOKEN|PRIVATE[_-]?KEY|MNEMONIC|SEED[_-]?PHRASE|RECOVERY[_-]?PHRASE)\s*=\s*)[^\s,;]{12,}/gi, "$1[REDACTED]");
}

/**
 * Helper masker buat tampilan ringkas: ambil 4 char awal + 4 char akhir,
 * sisanya di-mask. Aman untuk log "token: gh****abcd".
 */
export function maskSecret(value, { keepStart = 4, keepEnd = 4 } = {}) {
  const str = String(value || "");
  if (!str) return "";
  if (str.length <= keepStart + keepEnd) return "*".repeat(str.length);
  return `${str.slice(0, keepStart)}${"*".repeat(Math.max(4, str.length - keepStart - keepEnd))}${str.slice(-keepEnd)}`;
}

export function containsLikelySecret(value) {
  return redactSecrets(value) !== String(value ?? "");
}

export function assertNoSecretsForAi(value) {
  if (containsLikelySecret(value)) {
    throw new SecurityError("Konten terdeteksi mengandung secret dan tidak boleh masuk AI context.");
  }
  // Non-secret content is allowed after path and redaction checks.
  return;
}

export function truncateOutput(value, maxChars = config.maxOutputChars) {
  const text = redactSecrets(value);
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.65));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.25));
  return `${head}\n\n...[output dipotong, total ${text.length} karakter]...\n\n${tail}`;
}

export function checkRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter((timestamp) => now - timestamp < windowMs);
  if (fresh.length >= limit) {
    const retryAfterMs = windowMs - (now - fresh[0]);
    rateBuckets.set(key, fresh);
    return { allowed: false, retryAfterMs };
  }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return { allowed: true, retryAfterMs: 0 };
}

export function parseCommandLine(input) {
  const text = String(input || "").trim();
  const tokens = [];
  let current = "";
  let quote = null;

  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) throw new SecurityError("Command memiliki tanda kutip yang belum ditutup.");
  if (current) tokens.push(current);
  return tokens;
}

function assertNoDangerousCommandSyntax(command) {
  const lowered = command.toLowerCase();
  const withoutTrailingBackground = lowered.trim().replace(/\s*&\s*$/, "");
  if (withoutTrailingBackground.includes("&")) {
    throw new SecurityError('Operator shell "&" tidak diizinkan.');
  }
  for (const fragment of dangerousCommandFragments) {
    if (lowered.includes(fragment)) {
      throw new SecurityError(`Command diblokir karena mengandung pola berbahaya: ${fragment}`);
    }
  }
  for (const operator of shellOperators) {
    if (lowered.includes(operator)) {
      throw new SecurityError(`Operator shell "${operator}" tidak diizinkan.`);
    }
  }
}

export function getDestructiveCommandReason(command, { approved = false } = {}) {
  const normalized = String(command || "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";

  const lowered = normalized.toLowerCase();
  let tokens = [];
  try {
    tokens = parseCommandLine(normalized).map((token) => token.toLowerCase());
  } catch {
    tokens = lowered.split(/\s+/).filter(Boolean);
  }
  const executable = tokens[0] || "";
  const second = tokens[1] || "";

  if (/\brm\s+-(?:[a-z]*r[a-z]*f[a-z]*|[a-z]*f[a-z]*r[a-z]*)\b/i.test(normalized)) {
    return "`rm -rf` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (/\b(?:del|erase)\b(?=[^\r\n]*\/s)/i.test(normalized)) {
    return "`del /s` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (/\brd\b(?=[^\r\n]*\/s)/i.test(normalized)) {
    return "`rd /s` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (executable === "format" || executable === "format.com" || executable === "format.exe") {
    return "`format` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (executable === "diskpart" || executable === "diskpart.exe") {
    return "`diskpart` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (executable === "reg" && second === "delete") {
    return "`reg delete` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (/\b(?:shutdown|reboot|restart-computer|stop-computer)\b/i.test(normalized)) {
    return "Power command termasuk destructive/system-impact action dan butuh approval eksplisit.";
  }
  if (/\bdrop\s+database\b/i.test(normalized)) {
    return "`drop database` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (
    !approved &&
    /\bgit\s+push\b/i.test(normalized) &&
    /--force(?:-with-lease)?\b/i.test(normalized)
  ) {
    return "`git push --force` butuh approval eksplisit, terutama ke main/master.";
  }
  if (!approved && /\bgit\s+push\b/i.test(normalized)) {
    return "`git push` butuh approval eksplisit.";
  }
  if (!approved && /\bgit\s+reset\s+--hard\b/i.test(normalized)) {
    return "`git reset --hard` butuh approval eksplisit.";
  }
  if (!approved && /\bgit\s+clean\b/i.test(normalized)) {
    return "`git clean` butuh approval eksplisit.";
  }
  if (/\bremove-item\b(?=[^\r\n]*-(?:recurse|r)\b)/i.test(normalized)) {
    return "`Remove-Item -Recurse` termasuk destructive command dan butuh approval eksplisit.";
  }
  if (!approved && /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b/i.test(normalized)) {
    return "Install package/dependency butuh approval eksplisit.";
  }
  if (!approved && /\b(?:npm|pnpm|yarn)\s+(?:remove|uninstall)\b/i.test(normalized)) {
    return "Uninstall package/dependency butuh approval eksplisit.";
  }
  if (!approved && /\bnpm\s+publish\b/i.test(normalized)) {
    return "`npm publish` butuh approval eksplisit.";
  }
  if (!approved && /\b(?:vercel|netlify|firebase)\b(?=[^\r\n]*\bdeploy\b)|\bnpx\s+vercel\b/i.test(normalized)) {
    return "Deploy command butuh approval eksplisit.";
  }
  if (/\b(?:curl|wget)\b[\s\S]*\|[\s\S]*\b(?:bash|sh|powershell|pwsh)\b/i.test(normalized)) {
    return "`curl/wget | shell` diblokir karena remote script execution berisiko.";
  }
  if (/\bpowershell(?:\.exe)?\b[\s\S]*-(?:enc|encodedcommand)\b/i.test(normalized) || /\bpwsh(?:\.exe)?\b[\s\S]*-(?:enc|encodedcommand)\b/i.test(normalized)) {
    return "PowerShell encoded command diblokir karena sulit diaudit.";
  }
  if (/\b(?:get-content|cat|type|more)\b[\s\S]*(?:\.env\b|id_rsa|credentials?|tokens?|cookies?|sessions?|\.pem\b|\.key\b)/i.test(normalized)) {
    return "Credential/private file read butuh approval dan tidak boleh ditampilkan user-facing.";
  }

  return "";
}

function normalizeExecutable(name) {
  return String(name || "").trim().toLowerCase();
}

function getPlatformExecutable(executable) {
  if (process.platform !== "win32") return executable;
  if (executable === "npm") return "npm.cmd";
  if (executable === "npx") return "npx.cmd";
  if (executable === "pnpm") return "pnpm.cmd";
  if (executable === "yarn") return "yarn.cmd";
  return executable;
}

function assertRunnableScript(projectDir, userPath, allowedExtensions) {
  const resolved = resolveProjectPath(projectDir, userPath);
  assertNotSensitivePath(resolved);
  const extension = path.extname(resolved).toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    throw new SecurityError(`Ekstensi script tidak diizinkan. Hanya: ${allowedExtensions.join(", ")}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new SecurityError("File script tidak ditemukan.");
  }
  return path.relative(projectDir, resolved);
}

// Validate npm package name: scoped or unscoped, no shell tricks
function isSafePackageName(name) {
  return /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name);
}

// Validate git commit message: no shell operators
function isSafeCommitMessage(msg) {
  for (const op of shellOperators) {
    if (msg.includes(op)) return false;
  }
  return msg.length > 0 && msg.length < 500;
}

// Validate git branch name
function isSafeBranchName(name) {
  return /^[a-zA-Z0-9_.\/-]+$/.test(name) && !name.includes("..") && name.length < 100;
}

export function validateCommand(command, projectDir, { approved = false } = {}) {
  const normalizedInput = String(command || "").trim().replace(/\s+/g, " ");
  if (!normalizedInput) throw new SecurityError("Command wajib diisi.");
  assertNoDangerousCommandSyntax(normalizedInput);
  const destructiveReason = getDestructiveCommandReason(normalizedInput, { approved });
  if (destructiveReason) throw new SecurityError(`Command diblokir: ${destructiveReason}`);

  const tokens = parseCommandLine(normalizedInput);
  
  let isForcedBackground = false;
  if (tokens[tokens.length - 1] === "&") {
    isForcedBackground = true;
    tokens.pop();
  } else if (tokens[tokens.length - 1].endsWith("&")) {
    isForcedBackground = true;
    const lastToken = tokens.pop();
    tokens.push(lastToken.slice(0, -1));
  }

  if (tokens.length === 0) throw new SecurityError("Command wajib diisi.");

  const executable = normalizeExecutable(tokens[0]);
  const args = tokens.slice(1);
  if (!allowedCommandExecutables.has(executable)) {
    throw new SecurityError(`Command '${tokens[0]}' tidak ada di whitelist (npm/npx/pnpm/yarn/node/git).`);
  }

  // ── npm run <script> — detect long-running for background process management ──
  if (executable === "npm" && args.length >= 2 && args[0] === "run") {
    const scriptName = args[1];
    const longRunningScripts = ["dev", "start", "serve", "watch"];
    const isLongRunning = longRunningScripts.includes(scriptName) || isForcedBackground;
    return {
      executable: getPlatformExecutable("npm"),
      args,
      normalizedCommand: `npm ${args.join(" ")}`,
      isLongRunning,
      processLabel: isLongRunning ? "dev-server" : undefined
    };
  }

  // ── npm install / ci / uninstall / init / start — use npm.cmd on Windows ──
  if (executable === "npm") {
    const isLongRunning = args[0] === "start" || isForcedBackground;
    return {
      executable: getPlatformExecutable("npm"),
      args,
      normalizedCommand: `npm ${args.join(" ")}`,
      isLongRunning,
      processLabel: isLongRunning ? "dev-server" : undefined
    };
  }

  // ── npx — use npx.cmd on Windows ──
  if (executable === "npx") {
    const cleanArgs = args.filter(a => a !== "-y");
    return {
      executable: getPlatformExecutable("npx"),
      args: ["-y", ...cleanArgs],
      normalizedCommand: `npx -y ${cleanArgs.join(" ")}`,
      isLongRunning: isForcedBackground,
      processLabel: isForcedBackground ? "background-task" : undefined
    };
  }

  // ── All other commands — pass through directly ──
  return {
    executable,
    args,
    normalizedCommand: normalizedInput,
    isLongRunning: isForcedBackground,
    processLabel: isForcedBackground ? "background-task" : undefined
  };
}

export function formatRetryAfter(ms) {
  return `${Math.ceil(ms / 1000)} detik`;
}
