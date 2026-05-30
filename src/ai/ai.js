// ─────────────────────────────────────────────
// ai.js - single AI gateway for configured providers.
//
// Filosofi:
//   1. Persona utama diatur lewat system prompt + /persona user.
//   2. Single entry point: `chat(messages, opts)` — opts pilih agent.
//   3. Auto-fallback provider optional via config.
//   4. Helper kecil: `extractJson` + `readAgentInstructions` untuk
//      modul lain (agent.js).
// ─────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { config } from "../core/config.js";
import { runSelectedProvider } from "./extraCliProviders.js";
import { getLast } from "../core/memory.js";
import { redactSecrets, truncateOutput } from "../utils/security.js";
import { logger } from "../core/logger.js";

// ─────────────────────────────────────────────
// Default agent picker
// ─────────────────────────────────────────────
//
// Agent ids are provider-facing labels. Keep them aligned with O-W-O identity.

export const AGENTS = {
  CHAT: "o-w-o",
  CODE_CHAT: "o-w-o-coder",
  TOOLS: "o-w-o-tools",
  BUILD: "build"
};

// EventEmitter untuk observability runtime AI (termasuk auto-fallback provider).
export const aiEvents = new EventEmitter();

// ─────────────────────────────────────────────
// Message → single prompt converter
// ─────────────────────────────────────────────
//
// Provider runtime menerima single message string. Kalau input messages array
// (multi-turn / sistem+user), gabungin jadi 1 prompt dengan markers.

function joinSystem(messages) {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content || "")
    .filter(Boolean)
    .join("\n\n");
}

function withoutSystem(messages) {
  return messages.filter((m) => m.role !== "system");
}

function messagesToPrompt(messages, { json = false } = {}) {
  const system = joinSystem(messages);
  const conv = withoutSystem(messages);
  const parts = [];

  if (system) {
    parts.push("Instruksi sistem:");
    parts.push(system);
    parts.push("");
  }

  if (json) {
    parts.push("Format output:");
    parts.push("Reply with valid JSON only. No markdown fences, no preamble.");
    parts.push("");
  }

  if (conv.length > 1) {
    parts.push("Riwayat percakapan:");
    for (const m of conv.slice(0, -1)) {
      const role = m.role === "assistant" || m.role === "model" ? "Assistant" : "User";
      parts.push(`${role}: ${(m.content || "").trim()}`);
    }
    parts.push("");
    parts.push("Pesan user saat ini:");
    parts.push((conv[conv.length - 1]?.content || "").trim());
  } else if (conv.length === 1) {
    parts.push((conv[0].content || "").trim());
  }

  return parts.join("\n").trim();
}

// ─────────────────────────────────────────────
// Public API: chat
// ─────────────────────────────────────────────

/**
 * Send messages ke provider AI aktif (Gemini API key / Kiro API key).
 *
 * @param {Array<{role:string, content:string}> | string} messages
 *   Array OpenAI-format messages, atau plain string untuk shortcut.
 * @param {object} [opts]
 * @param {string} [opts.agent]   - provider agent name (default: o-w-o)
 * @param {string} [opts.model]   - Model override (default: config.aiModel)
 * @param {boolean} [opts.json]   - Validasi output JSON, retry kalau invalid
 * @param {number} [opts.maxJsonRetries] - Max retry kalau JSON malformed
 * @returns {Promise<string>} Reply text (sudah di-redact secret).
 */
export async function chat(messages, opts = {}) {
  const {
    agent = AGENTS.CHAT,
    model = config.aiModel,
    json = false,
    maxJsonRetries = json ? 1 : 0
  } = opts;

  const msgArray = typeof messages === "string"
    ? [{ role: "user", content: messages }]
    : messages;

  let attempt = 0;
  let workingMessages = msgArray;
  let lastError = null;

  while (attempt <= maxJsonRetries) {
    const prompt = messagesToPrompt(workingMessages, { json });

    let raw;
    try {
      raw = await runSelectedProvider(prompt, {
        model,
        agent,
        onFallback: (info) => {
          try {
            aiEvents.emit("fallback", info);
          } catch {}
        }
      });
    } catch (err) {
      throw err;
    }

    if (!raw || !raw.trim()) {
      throw new Error("Respons AI kosong.");
    }

    if (json) {
      try {
        extractJson(raw);
        return redactSecrets(raw);
      } catch (jsonErr) {
        lastError = jsonErr;
        if (attempt < maxJsonRetries) {
          try { await logger.warn("AI JSON malformed, retrying", { attempt }); } catch {}
          workingMessages = [
            ...workingMessages,
            { role: "assistant", content: raw },
            {
              role: "user",
              content: "Respons sebelumnya bukan JSON valid. Balas ulang HANYA dengan JSON valid sesuai format. Jangan markdown fence, jangan teks pengantar."
            }
          ];
          attempt++;
          continue;
        }
        throw jsonErr;
      }
    }

    return redactSecrets(raw);
  }

  throw lastError || new Error("AI gagal merespons.");
}

// ─────────────────────────────────────────────
// JSON extractor (toleran markdown fence / leading text / trailing junk)
// ─────────────────────────────────────────────
//
// Strategy:
//   1. Strip markdown fences (```json, ```).
//   2. Try direct JSON.parse on the cleaned text.
//   3. Find the first balanced { ... } block (respect strings & escapes).
//   4. Same for [ ... ] arrays.
//   5. As last-resort: greedy substring between first `{` and last `}`.
//
// Returns the parsed value. Throws Error("AI tidak mengembalikan JSON valid.")
// only when none of the strategies produce parseable JSON.

function stripFences(text) {
  return String(text || "")
    .trim()
    // strip leading ```json / ```js / ``` opener
    .replace(/^\s*```(?:json|jsonc|js|javascript|ts|typescript)?\s*\r?\n?/i, "")
    // strip trailing ```
    .replace(/\r?\n?```\s*$/i, "")
    .trim();
}

function findBalanced(text, open, close) {
  // Scan for the FIRST balanced open..close block, respecting "string" literals.
  let start = -1;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) {
      if (start === -1) start = i;
      depth++;
    } else if (ch === close && start !== -1) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(text) {
  const cleaned = stripFences(text);
  if (!cleaned) throw new Error("AI tidak mengembalikan JSON valid.");

  // 1) Direct parse
  try { return JSON.parse(cleaned); } catch {}

  // 2) Balanced object
  const obj = findBalanced(cleaned, "{", "}");
  if (obj) {
    try { return JSON.parse(obj); } catch {}
  }

  // 3) Balanced array
  const arr = findBalanced(cleaned, "[", "]");
  if (arr) {
    try { return JSON.parse(arr); } catch {}
  }

  // 4) Greedy slice (legacy fallback)
  const oStart = cleaned.indexOf("{");
  const oEnd = cleaned.lastIndexOf("}");
  if (oStart >= 0 && oEnd > oStart) {
    try { return JSON.parse(cleaned.slice(oStart, oEnd + 1)); } catch {}
  }
  const aStart = cleaned.indexOf("[");
  const aEnd = cleaned.lastIndexOf("]");
  if (aStart >= 0 && aEnd > aStart) {
    try { return JSON.parse(cleaned.slice(aStart, aEnd + 1)); } catch {}
  }

  throw new Error("AI tidak mengembalikan JSON valid.");
}

// ─────────────────────────────────────────────
// SOUL.md / AGENT.md reader
// ─────────────────────────────────────────────

/**
 * Baca SOUL.md / AGENT.md / AGENTS.md / .cursor/rules/main.mdc dari
 * project root. Dipakai untuk inject project-specific rules ke task prompt.
 */
export async function readAgentInstructions(projectDir) {
  if (!projectDir) return "";
  const candidates = ["SOUL.md", "AGENT.md", "AGENTS.md", ".cursor/rules/main.mdc"];
  const chunks = [];
  let remaining = 8000;
  for (const name of candidates) {
    const filePath = path.join(projectDir, name);
    try {
      const text = await fs.readFile(filePath, "utf8");
      const trimmed = text.trim();
      if (!trimmed) continue;
      const chunk = truncateOutput(trimmed, Math.min(remaining, 3000));
      chunks.push(`=== ${name} ===\n${chunk}`);
      remaining -= chunk.length;
      if (remaining <= 1000) break;
    } catch {}
  }
  return truncateOutput(chunks.join("\n\n"), 8000);
}

// ─────────────────────────────────────────────
// Audio transcription — DISABLED
// ─────────────────────────────────────────────

export async function transcribeAudio() {
  throw new Error("Voice note tidak didukung. Kirim teks aja ya.");
}

function buildNaturalToneSystem({ coding = false, persona = "" } = {}) {
  const agentName = config.agentName || "O-W-O";
  const lines = [
    `Kamu adalah ${agentName}, Telegram Familiar / Coding Agent milik ${config.agentOwner || "owner"}.`,
    "Kamu bukan chatbot generic dan bukan remote shell proxy.",
    "Chat response wajib Bahasa Indonesia dengan register aku/kamu.",
    "Gunakan aku/kamu only. Hindari register formal, slang kasar, emoji, emoticon, kaomoji, hype opening, atau basa-basi.",
    "Technical terms tetap English: API, deploy, debug, branch, commit, issue, pull request, endpoint, token, provider, connector.",
    "Jawab direct, sharp, santai, teknis, singkat tapi lengkap.",
    "Kalau tidak yakin, bilang tidak yakin.",
    "Kalau instruksi user buruk, risky, destructive, public-impact, credential-impact, atau outside-scope, push back dan minta approval.",
    "Memory persistent hanya untuk preferensi stabil, environment facts, project facts, repeated corrections, dan workflow valid.",
    "Skills adalah procedural reusable workflow. Jangan auto-save skill tanpa approval.",
    "Jangan print secret, jangan minta user paste token ke chat, dan jangan masukkan .env ke AI context."
  ];

  if (coding) {
    lines.push("Untuk coding: baca konteks dulu, jelaskan tradeoff teknis, verifikasi dengan npm run check jika ada, lalu build/lint/test yang relevan.");
  }

  if (persona) {
    lines.push(`Persona tambahan dari user: ${persona}`);
  }

  return lines.join("\n");
}

async function getPersonaInstruction() {
  try {
    const raw = await getLast("persona");
    if (typeof raw !== "string") return "";
    return raw.trim().slice(0, 1000);
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────
// High-level helpers (public API untuk commands.js)
// ─────────────────────────────────────────────

/**
 * Tanya AI untuk obrolan umum / Q&A.
 * Persona disusun dari system prompt internal + opsi /persona user.
 *
 * Note: contextHints.userName SENGAJA tidak di-inject ke message,
 * karena prefix "Nama user: X" bikin AI keliru ngira message itu sapaan
 * baru padahal user lagi nanya beneran. Kalo butuh address user
 * by name, edit agent profile untuk include placeholder.
 */
export async function askGeneralQuestion({ question } = {}) {
  if (!question || !String(question).trim()) {
    throw new Error("Pertanyaan kosong.");
  }

  const persona = await getPersonaInstruction();
  const agentInstructions = await readAgentInstructions(config.projectRoot || config.projectDir).catch(() => "");
  const message = String(question).trim();
  const answer = await chat([
    {
      role: "system",
      content: [
        buildNaturalToneSystem({ coding: false, persona }),
        agentInstructions ? `\nProject rules dari SOUL.md/AGENT.md:\n${agentInstructions}` : ""
      ].filter(Boolean).join("\n")
    },
    { role: "user", content: message }
  ], { agent: AGENTS.CHAT });
  return truncateOutput(answer, config.maxOutputChars);
}

/**
 * Tanya AI dengan konteks project file.
 */
export async function askProjectQuestion({ projectDir, question, contextHints = {} } = {}) {
  if (!question || !String(question).trim()) {
    throw new Error("Pertanyaan kosong.");
  }

  const { getProjectContext } = await import("../utils/fileManager.js");
  const ctx = await getProjectContext(projectDir).catch(() => "(project context tidak tersedia)");
  const agentInstructions = await readAgentInstructions(projectDir);
  const persona = await getPersonaInstruction();

  const messages = [];
  messages.push({
    role: "system",
    content: buildNaturalToneSystem({ coding: true, persona })
  });
  if (agentInstructions) {
    messages.push({
      role: "system",
      content: `Project rules dari SOUL.md/AGENT.md:\n${agentInstructions}`
    });
  }
  messages.push({
    role: "user",
    content: [
      "Konteks project (sudah disaring dari secret):",
      ctx,
      "",
      `Pertanyaan: ${String(question).trim()}`
    ].join("\n")
  });

  const answer = await chat(messages, { agent: AGENTS.CODE_CHAT });
  return truncateOutput(answer, config.maxOutputChars);
}

// ─────────────────────────────────────────────
// File proposal helpers (edit / fix / create)
// ─────────────────────────────────────────────

/**
 * Internal: bikin proposal isi file dalam format JSON.
 * Format: { summary: string, content: string }
 */
async function proposeFileJson({ projectDir, filePath, currentContent = "", instruction, mode }) {
  const { assertNoSecretsForAi } = await import("../utils/security.js");
  if (currentContent) assertNoSecretsForAi(currentContent);

  const { getProjectContext } = await import("../utils/fileManager.js");
  const ctx = await getProjectContext(projectDir).catch(() => "");
  const agentInstructions = await readAgentInstructions(projectDir);

  const taskByMode = {
    edit: "Edit file berikut sesuai instruksi user. Kembalikan isi file LENGKAP (bukan diff).",
    fix: "Perbaiki file berikut berdasarkan error / masalah yg di-describe user. Kembalikan isi file LENGKAP.",
    create: "Buat file baru sesuai instruksi user. Kembalikan isi file LENGKAP."
  };

  const systemContent = [
    `Kamu adalah ${config.agentName || "O-W-O"}, Telegram Familiar / Coding Agent yang bikin proposal perubahan file.`,
    "Kamu wajib mengikuti SOUL.md dan AGENT.md.",
    "Output WAJIB JSON valid: {\"summary\": \"ringkasan singkat 1 kalimat\", \"content\": \"isi file lengkap\"}",
    "JANGAN markdown fence, JANGAN preamble, JANGAN trailing text.",
    "Field content harus isi file PENUH yang siap di-write, bukan partial / diff.",
    "Ikuti convention project (framework, naming, style).",
    "Jangan hardcode credential/token/key.",
    "Code dan comments tetap English.",
    "Jika instruksi user risky/destructive/outside-scope, jangan mengarang bypass.",
    agentInstructions ? `\n=== PROJECT RULES (SOUL.md / AGENT.md) ===\n${agentInstructions}` : ""
  ].filter(Boolean).join("\n");

  const userParts = [
    `Task: ${taskByMode[mode] || taskByMode.edit}`,
    "",
    `Path file: ${filePath}`,
    ""
  ];
  if (ctx) {
    userParts.push("Konteks project:", ctx, "");
  }
  if (currentContent && mode !== "create") {
    userParts.push("Isi file saat ini:", "```", currentContent, "```", "");
  }
  userParts.push(`Instruksi user: ${instruction}`);

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userParts.join("\n") }
  ];

  const raw = await chat(messages, {
    agent: AGENTS.CODE_CHAT,
    json: true,
    maxJsonRetries: 2
  });

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI ga balas JSON valid.");
  }
  if (typeof parsed.content !== "string") {
    throw new Error('AI ga return field "content" string.');
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    parsed.summary = `${mode} ${filePath}`;
  }

  assertNoSecretsForAi(parsed.content);
  return {
    summary: redactSecrets(parsed.summary.trim()),
    content: parsed.content
  };
}

export async function proposeFileEdit({ projectDir, filePath, currentContent, instruction }) {
  return proposeFileJson({ projectDir, filePath, currentContent, instruction, mode: "edit" });
}

export async function proposeFileFix({ projectDir, filePath, currentContent, errorText }) {
  return proposeFileJson({
    projectDir,
    filePath,
    currentContent,
    instruction: `Perbaiki error / masalah berikut:\n${errorText}`,
    mode: "fix"
  });
}

export async function proposeNewFile({ projectDir, filePath, instruction }) {
  return proposeFileJson({ projectDir, filePath, instruction, mode: "create" });
}

// ─────────────────────────────────────────────
// Intent classifier — AI fallback untuk kasus ambigu
// ─────────────────────────────────────────────
//
// Fast path tetap di commands.js (ruleBasedIntent). Function ini dipanggil saat
// rule-based tidak yakin. Output WAJIB JSON supaya mudah di-parse.

export async function classifyNaturalLanguageIntent({ message, replyText = "", memorySummary = "" } = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return {
      intent: "ask_general",
      instruction: "",
      needsConfirmation: false,
      confidence: 0.5,
      reason: "Pesan kosong"
    };
  }

  const agentInstructions = await readAgentInstructions(config.projectRoot || config.projectDir).catch(() => "");
  const system = [
    `Kamu adalah intent classifier untuk ${config.agentName || "O-W-O"}, Telegram Familiar / Coding Agent.`,
    "Klasifikasikan 1 pesan user ke salah satu intent yang tersedia.",
    "Balas HANYA JSON valid (tanpa markdown fence/preamble).",
    "",
    "Allowed intents:",
    "- ask_general (obrolan umum, QnA umum)",
    "- ask_project (pertanyaan teknis tentang project aktif)",
    "- read_file",
    "- search_project",
    "- run_command",
    "- edit_file",
    "- fix_file",
    "- create_file",
    "- delete_file",
    "- rollback",
    "- format_code",
    "- status",
    "- get_logs",
    "- deploy",
    "- tunnel",
    "- kill_port",
    "- git_push",
    "- zip_backup",
    "- sys_lock",
    "- sys_shutdown",
    "- sys_restart",
    "",
    "Output schema:",
    '{"intent":"ask_general","instruction":"teks instruksi ringkas","filePath":"","query":"","command":"","port":"","needsConfirmation":false,"confidence":0.0,"reason":"alasan singkat"}',
    "",
    "Rules:",
    "1) confidence harus 0..1",
    "2) Jika ragu, pilih ask_general dengan confidence <= 0.55",
    "3) needsConfirmation=true untuk aksi mutasi (edit/create/delete/fix/rollback/run_command/deploy/git_push/sys_*)",
    "4) Jangan mengarang filePath/command/port kalau tidak jelas (isi string kosong)",
    "5) instruction harus ringkas dan merepresentasikan maksud user",
    "6) action destructive/public/credential/outside-scope harus needsConfirmation=true",
    "7) natural language aman boleh jalan, tapi approval boundary tetap menang",
    agentInstructions ? `\n=== SOUL.md / AGENT.md ===\n${agentInstructions}` : ""
  ].join("\n");

  const user = [
    `Pesan user:\n${text}`,
    replyText ? `\nKonteks reply:\n${replyText}` : "",
    memorySummary ? `\nMemory summary:\n${truncateOutput(String(memorySummary), 3000)}` : ""
  ].filter(Boolean).join("\n");

  const raw = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    {
      agent: AGENTS.TOOLS,
      json: true,
      maxJsonRetries: 2
    }
  );

  const parsed = extractJson(raw);
  const intent = typeof parsed?.intent === "string" ? parsed.intent : "ask_general";
  const confidenceNum = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceNum)
    ? Math.max(0, Math.min(1, confidenceNum))
    : 0.5;

  return {
    intent,
    instruction: typeof parsed?.instruction === "string" && parsed.instruction.trim()
      ? parsed.instruction.trim()
      : text,
    filePath: typeof parsed?.filePath === "string" ? parsed.filePath.trim() : "",
    query: typeof parsed?.query === "string" ? parsed.query.trim() : "",
    command: typeof parsed?.command === "string" ? parsed.command.trim() : "",
    port: typeof parsed?.port === "string" ? parsed.port.trim() : "",
    needsConfirmation: Boolean(parsed?.needsConfirmation),
    confidence,
    reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : ""
  };
}
