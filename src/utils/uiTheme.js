// Design system helpers for Telegram messages.
// Goal: konsisten, rapi, tidak norak. Hindari emoji-noise & ALL-CAPS overload.
//
// Pakai Markdown V1 (default node-telegram-bot-api parse_mode "Markdown")
// karena MarkdownV2 escape-nya rewel banget.

// ─────────────────────────────────────────────
// Tone tokens — single emoji per concept
// ─────────────────────────────────────────────

export const T = {
  ok: "✓",
  fail: "✗",
  pending: "·",
  arrow: "→",
  bullet: "•",
  divider: "─",

  // Status-coded markers (keep emoji rare & meaningful)
  success: "✅",
  error: "❌",
  warn: "⚠️",
  info: "ℹ️",

  // Neutral category icons — hanya untuk header section
  agent: "🤖",
  cli: "⌘",
  project: "📁",
  file: "📄",
  git: "⎇",
  build: "▣",
  perf: "⚡",
  brain: "◉",
  laptop: "▦",
  media: "♪",
  search: "⌕",
  time: "⏱",
  spark: "✦"
};

// ─────────────────────────────────────────────
// Layout primitives
// ─────────────────────────────────────────────

const WIDTH = 28; // visual width target for dividers
const DIV_CHAR = "─";

export function divider(char = DIV_CHAR, width = WIDTH) {
  return char.repeat(width);
}

/**
 * Section header. Avoids the noisy `══════════════════` style.
 *
 *   header("AGENT", "tool-calling mode") =>
 *   `*AGENT* · _tool-calling mode_`
 *   `────────────────────────────`
 */
export function header(title, subtitle = "", { icon = "" } = {}) {
  const left = icon ? `${icon}  *${title}*` : `*${title}*`;
  const top = subtitle ? `${left}  ·  _${subtitle}_` : left;
  return `${top}\n${divider()}`;
}

/**
 * Compact key/value row. Right-pad keys to align nicely.
 *
 *   kv("Project", "myapp") => "_Project_   `myapp`"
 */
export function kv(label, value, { mono = true } = {}) {
  const v = value === undefined || value === null || value === "" ? "—" : value;
  return `_${label}_   ${mono ? `\`${v}\`` : v}`;
}

/**
 * Small inline status badge.
 *
 *   badge("ok", "build")   => "`✓ build`"
 *   badge("fail", "build") => "`✗ build`"
 */
export function badge(state, label) {
  const map = {
    ok: T.ok,
    success: T.ok,
    fail: T.fail,
    error: T.fail,
    pending: T.pending,
    warn: T.warn
  };
  const sym = map[state] || T.pending;
  return `\`${sym} ${label}\``;
}

/**
 * Bullet list with consistent indent.
 */
export function bullets(items, { indent = "" } = {}) {
  return items.filter(Boolean).map((line) => `${indent}${T.bullet} ${line}`).join("\n");
}

/**
 * Card composition: header + body lines + optional footer.
 * Returns a single Markdown string ready for sendMessage.
 */
export function card({ icon = "", title, subtitle = "", body = [], footer = "" }) {
  const parts = [header(title, subtitle, { icon })];
  if (Array.isArray(body)) {
    parts.push(body.filter(Boolean).join("\n"));
  } else if (body) {
    parts.push(body);
  }
  if (footer) {
    parts.push("");
    parts.push(`_${footer}_`);
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * Two-column compact summary stat row.
 *   stats([["files", "3"], ["tools", "12"], ["build", "OK"]])
 *   => "files `3`  ·  tools `12`  ·  build `OK`"
 */
export function stats(pairs) {
  return pairs
    .filter(Boolean)
    .map(([k, v]) => `${k} \`${v}\``)
    .join("  ·  ");
}

/**
 * Code block with optional language. Trims trailing whitespace.
 */
export function code(text, lang = "") {
  const safe = String(text || "").replace(/```/g, "ʼʼʼ").trimEnd();
  return `\`\`\`${lang}\n${safe}\n\`\`\``;
}

/**
 * Footer breadcrumb showing active context.
 *   breadcrumb({ project: "myapp", engine: "claude-cli/opus", server: "running" })
 */
export function breadcrumb({ project, engine, server, mode } = {}) {
  const parts = [];
  if (project) parts.push(`📁 ${project}`);
  if (engine) parts.push(`◉ ${engine}`);
  if (server === "running") parts.push("● live");
  else if (server === "idle") parts.push("○ idle");
  if (mode) parts.push(`◐ ${mode}`);
  if (!parts.length) return "";
  return `\n${divider()}\n_${parts.join("  ·  ")}_`;
}

/**
 * Suggestion chip row — quick follow-up actions.
 * Returns inline_keyboard layout.
 */
export function suggestionChips(chips) {
  // chips: [{ text, callback_data }]
  if (!chips || chips.length === 0) return null;
  const rows = [];
  for (let i = 0; i < chips.length; i += 2) {
    rows.push(chips.slice(i, i + 2));
  }
  return { reply_markup: { inline_keyboard: rows } };
}

/**
 * Truncate text in the middle, keeping head and tail.
 */
export function truncMid(text, maxLen = 60) {
  const s = String(text || "");
  if (s.length <= maxLen) return s;
  const head = Math.floor((maxLen - 1) / 2);
  const tail = maxLen - 1 - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

/**
 * Combine a card + breadcrumb + optional reply markup into a single options
 * object plus the body text. Returns { text, options }.
 */
export function compose(cardObj, { reply_markup, parse_mode = "Markdown", crumb } = {}) {
  let text = typeof cardObj === "string" ? cardObj : card(cardObj);
  if (crumb) text += breadcrumb(crumb);
  return {
    text,
    options: {
      parse_mode,
      ...(reply_markup ? { reply_markup } : {})
    }
  };
}
