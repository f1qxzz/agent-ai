// ─────────────────────────────────────────────
// approvalPolicy.js — pending approval store + policy classifier.
//
// Aksi berisiko (push, merge, post, dll) tidak langsung jalan. Bot bikin
// "approval ticket" dengan ID, lalu user reply /approve <id> atau /reject <id>.
//
// Pending approval disimpan di data/approvals.json (durable across restart).
// File ini PURE: tidak panggil Telegram/AI. commands.js yang format pesan-nya.
// ─────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../core/config.js";
import { redactSecrets } from "../utils/security.js";

const APPROVAL_FILE = path.join(config.dataDir, "approvals.json");
const APPROVAL_TTL_MS = 30 * 60 * 1000; // 30 menit

// ─────────────────────────────────────────────
// Risk policy
// ─────────────────────────────────────────────

const RISK = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical"
};

/**
 * Map "service:action" -> risk level. Aksi yang TIDAK ada di sini dianggap
 * LOW (read/status/list) dan tidak perlu approval.
 *
 * Aksi WAJIB approval kalau MEDIUM atau lebih tinggi.
 */
const ACTION_RISK = {
  // ── Git / GitHub ─────────────────────────────
  "git:push": RISK.HIGH,
  "git:push-force": RISK.CRITICAL,
  "git:reset-hard": RISK.HIGH,
  "git:clean": RISK.HIGH,
  "github:push": RISK.HIGH,
  "github:create_pr": RISK.MEDIUM,
  "github:create_repo": RISK.HIGH,
  "github:merge_pr": RISK.HIGH,
  "github:close_pr": RISK.MEDIUM,
  "github:delete_branch": RISK.HIGH,
  "github:delete_repo": RISK.CRITICAL,
  "github:update_repo": RISK.MEDIUM,
  "github:add_collaborator": RISK.HIGH,
  "github:remove_collaborator": RISK.HIGH,
  "github:update_secret": RISK.CRITICAL,
  "github:create_release": RISK.HIGH,
  "github:create_issue": RISK.MEDIUM,
  "github:close_issue": RISK.MEDIUM,
  "github:comment_issue": RISK.MEDIUM,
  "github:dispatch_workflow": RISK.MEDIUM,

  // ── Discord ──────────────────────────────────
  "discord:send_message_allowed": RISK.LOW,      // ke channel allowlist -> langsung
  "discord:send_message_unallowed": RISK.HIGH,   // di luar allowlist -> approval
  "discord:mention_everyone": RISK.HIGH,
  "discord:delete_message": RISK.HIGH,
  "discord:kick_member": RISK.CRITICAL,
  "discord:ban_member": RISK.CRITICAL,
  "discord:update_role": RISK.HIGH,
  "discord:update_permission": RISK.HIGH,
  "discord:bulk_send": RISK.HIGH,

  // ── X / Twitter ──────────────────────────────
  "x:post_tweet": RISK.HIGH,
  "x:reply_public": RISK.HIGH,
  "x:delete_tweet": RISK.HIGH,
  "x:follow": RISK.MEDIUM,
  "x:unfollow": RISK.MEDIUM,
  "x:dm": RISK.HIGH,
  "x:bulk_like": RISK.HIGH,
  "x:bulk_retweet": RISK.HIGH,
  "x:update_profile": RISK.HIGH,

  // ── Deploy / Infra / Filesystem ──────────────
  "deploy:vercel": RISK.HIGH,
  "deploy:any": RISK.HIGH,
  "terminal:command": RISK.MEDIUM,
  "npm:install": RISK.MEDIUM,
  "npm:publish": RISK.CRITICAL,
  "fs:delete_bulk": RISK.HIGH,
  "system:shutdown": RISK.HIGH,
  "system:restart": RISK.HIGH,
  "credential:rotate": RISK.CRITICAL,
  "credential:read": RISK.CRITICAL,
  "session:clear": RISK.MEDIUM,
  "fs:outside_workspace": RISK.HIGH
};

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export function getActionRisk(actionId) {
  return ACTION_RISK[actionId] || RISK.LOW;
}

export function requiresApproval(actionId) {
  const level = getActionRisk(actionId);
  return RISK_RANK[level] >= RISK_RANK[RISK.MEDIUM];
}

export const APPROVAL_RISK = RISK;

// ─────────────────────────────────────────────
// Persistent pending store
// ─────────────────────────────────────────────

async function readStore() {
  try {
    const raw = await fs.readFile(APPROVAL_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.pending)) return parsed;
  } catch {}
  return { pending: [] };
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(APPROVAL_FILE), { recursive: true });
  await fs.writeFile(APPROVAL_FILE, JSON.stringify(store, null, 2), "utf8");
}

function isExpired(entry) {
  if (!entry?.createdAt) return true;
  if (entry.expiresAt) return Date.now() > Number(entry.expiresAt);
  return Date.now() - entry.createdAt > APPROVAL_TTL_MS;
}

async function pruneExpired(store) {
  const fresh = (store.pending || []).filter((entry) => !isExpired(entry));
  if (fresh.length !== (store.pending || []).length) {
    store.pending = fresh;
    await writeStore(store);
  }
  return store;
}

function shortId() {
  // 6 hex char, easy to type on phone
  return crypto.randomBytes(3).toString("hex");
}

function maskApprovalPayload(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactSecrets(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => maskApprovalPayload(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      out[key] = maskApprovalPayload(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Bikin approval ticket baru.
 *
 * @param {object} input
 * @param {string} input.service        - "github" | "discord" | "x" | "git" | ...
 * @param {string} input.action         - human label, mis. "push to GitHub"
 * @param {string} input.actionId       - id buat policy lookup, mis. "github:push"
 * @param {string} [input.target]       - "owner/repo", "channel #general", dll.
 * @param {object} [input.payload]      - data yang diperlukan untuk eksekusi
 * @param {string} [input.userId]
 * @param {string} [input.chatId]
 * @returns {Promise<object>} ticket
 */
export async function createApproval(input) {
  const store = await pruneExpired(await readStore());
  const createdAt = Date.now();
  const actionId = String(input.actionId || `${input.service || "unknown"}:unspecified`);
  const maskedPayload = maskApprovalPayload(input.payload || {});
  const command = input.command || input.payload?.command || "";

  const ticket = {
    id: shortId(),
    service: String(input.service || "unknown"),
    action: String(input.action || "unspecified action"),
    actionId,
    target: input.target ? redactSecrets(String(input.target)).slice(0, 200) : "",
    risk: getActionRisk(actionId),
    reason: input.reason ? redactSecrets(String(input.reason)).slice(0, 1000) : "",
    preview: input.preview ? redactSecrets(String(input.preview)).slice(0, 2000) : "",
    command: command ? redactSecrets(String(command)).slice(0, 2000) : "",
    payload: maskedPayload,
    userId: input.userId ? String(input.userId) : "",
    chatId: input.chatId ? String(input.chatId) : "",
    createdAt,
    expiresAt: createdAt + APPROVAL_TTL_MS,
    createdBy: input.createdBy ? String(input.createdBy) : (input.userId ? String(input.userId) : ""),
    status: "pending"
  };

  store.pending.unshift(ticket);
  // Keep last 30 to prevent file bloat
  store.pending = store.pending.slice(0, 30);
  await writeStore(store);
  return ticket;
}

export async function listPending({ userId } = {}) {
  const store = await pruneExpired(await readStore());
  if (!userId) return store.pending;
  return store.pending.filter((t) => !t.userId || t.userId === String(userId));
}

export async function getApproval(id) {
  if (!id) return null;
  const store = await pruneExpired(await readStore());
  return store.pending.find((t) => t.id === String(id).toLowerCase()) || null;
}

export async function resolveApproval(id, { decision, userId } = {}) {
  if (!id) return { ok: false, reason: "ID approval kosong." };
  const store = await pruneExpired(await readStore());
  const idx = store.pending.findIndex((t) => t.id === String(id).toLowerCase());
  if (idx < 0) {
    return { ok: false, reason: `Approval \`${id}\` tidak ditemukan / expired.` };
  }
  const ticket = store.pending[idx];
  if (ticket.userId && userId && ticket.userId !== String(userId)) {
    return { ok: false, reason: "Kamu bukan owner approval ini." };
  }

  store.pending.splice(idx, 1);
  await writeStore(store);
  return { ok: true, ticket: { ...ticket, status: decision === "approve" ? "approved" : "rejected" } };
}

export function formatApprovalMessage(ticket) {
  const expires = ticket.expiresAt ? new Date(ticket.expiresAt).toISOString() : "";
  const payloadPreview = ticket.command
    ? ticket.command
    : (ticket.payload && Object.keys(ticket.payload).length ? JSON.stringify(ticket.payload, null, 2).slice(0, 1200) : "");
  const lines = [
    "*Approval dibutuhkan*",
    "------------------",
    `ID: \`${ticket.id}\``,
    `Service: \`${ticket.service}\``,
    `Action: \`${ticket.action}\``,
    ticket.target ? `Target: \`${ticket.target}\`` : null,
    `Risiko: \`${ticket.risk.toUpperCase()}\``,
    ticket.reason ? `Reason: ${ticket.reason}` : null,
    ticket.preview ? `Preview:\n\`\`\`\n${ticket.preview.replace(/```/g, "'''")}\n\`\`\`` : null,
    payloadPreview ? `Masked command/payload:\n\`\`\`\n${payloadPreview.replace(/```/g, "'''")}\n\`\`\`` : null,
    expires ? `Expires: \`${expires}\`` : null,
    ticket.createdBy ? `Created by: \`${ticket.createdBy}\`` : null,
    "",
    `Jalankan: \`/approve ${ticket.id}\``,
    `Batalkan: \`/reject ${ticket.id}\``
  ].filter(Boolean);
  return lines.join("\n");
}
