// ─────────────────────────────────────────────
// connectorManager.js — registry untuk semua connector eksternal.
//
// Tugas:
//   1. Menyediakan list connector aktif/tidak aktif.
//   2. Memetakan service+action ke implementasi.
//   3. Menerapkan policy approval (lihat approvalPolicy.js).
//   4. Mengeksekusi action setelah approval di-approve.
// ─────────────────────────────────────────────

import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { redactSecrets } from "../utils/security.js";
import {
  createApproval,
  resolveApproval,
  getApproval,
  requiresApproval,
  formatApprovalMessage
} from "./approvalPolicy.js";

import { githubConnector } from "./githubConnector.js";
import { discordConnector } from "./discordConnector.js";
import { xConnector } from "./xConnector.js";

const REGISTRY = {
  github: githubConnector,
  discord: discordConnector,
  x: xConnector
};

// Aliases biar natural language gampang resolve.
const ALIASES = {
  gh: "github",
  github: "github",
  twitter: "x",
  x: "x",
  discord: "discord",
  ds: "discord"
};

export function resolveServiceId(input) {
  const key = String(input || "").trim().toLowerCase();
  if (!key) return null;
  return ALIASES[key] || (REGISTRY[key] ? key : null);
}

export function getConnector(serviceId) {
  const id = resolveServiceId(serviceId);
  if (!id) return null;
  return REGISTRY[id] || null;
}

export function listConnectors() {
  return Object.values(REGISTRY).map((c) => ({
    id: c.id,
    label: c.label,
    enabled: c.isEnabled(),
    status: c.getStatus()
  }));
}

export function listActiveConnectors() {
  return listConnectors().filter((c) => c.enabled);
}

export async function refreshConnector(serviceId) {
  const connector = getConnector(serviceId);
  if (!connector) return { ok: false, reason: `Connector "${serviceId}" tidak dikenal.` };
  try {
    connector.refresh();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: redactSecrets(err.message) };
  }
}

export async function testConnector(serviceId) {
  const connector = getConnector(serviceId);
  if (!connector) return { ok: false, reason: `Connector "${serviceId}" tidak dikenal.` };
  try {
    return await connector.testConnection();
  } catch (err) {
    return { ok: false, reason: redactSecrets(err.message), help: connector.envHelp?.() };
  }
}

export async function statusConnector(serviceId) {
  const connector = getConnector(serviceId);
  if (!connector) return { ok: false, reason: `Connector "${serviceId}" tidak dikenal.` };
  return { ok: true, status: connector.getStatus() };
}

// ─────────────────────────────────────────────
// Approval-aware action runner
// ─────────────────────────────────────────────

/**
 * Execute connector action. Kalau action MEDIUM/HIGH/CRITICAL, function ini
 * tidak menjalankan handler — sebagai gantinya bikin approval ticket lalu
 * return { needsApproval: true, ticket }.
 *
 * Caller (commands.js) yang format pesan approval ke Telegram.
 *
 * @param {object} input
 * @param {string} input.service           "github" | "discord" | "x"
 * @param {string} input.action            handler key di connector (mis. "createIssue")
 * @param {string} [input.actionId]        kunci policy (mis. "github:create_issue")
 * @param {string} [input.label]           teks human-readable buat ticket
 * @param {string} [input.target]          "owner/repo", "channel name"
 * @param {object} [input.payload]         args yang akan dipassing ke handler
 * @param {string|number} [input.userId]
 * @param {string|number} [input.chatId]
 * @param {boolean} [input.skipApproval]   set true HANYA setelah ticket di-/approve
 */
export async function executeAction(input) {
  const serviceId = resolveServiceId(input.service);
  if (!serviceId) {
    return { ok: false, reason: `Service "${input.service}" tidak dikenal.` };
  }
  const connector = REGISTRY[serviceId];
  if (!connector.isEnabled()) {
    return {
      ok: false,
      reason: `Connector ${connector.label} dimatikan.`,
      help: connector.envHelp?.()
    };
  }

  const actionId = input.actionId || `${serviceId}:${input.action}`;
  const handler = connector[input.action];

  if (typeof handler !== "function") {
    return { ok: false, reason: `Action "${input.action}" tidak ada di ${connector.label}.` };
  }

  if (!input.skipApproval && requiresApproval(actionId)) {
    const ticket = await createApproval({
      service: serviceId,
      actionId,
      action: input.label || input.action,
      target: input.target || "",
      payload: input.payload || {},
      userId: input.userId,
      chatId: input.chatId
    });
    try {
      await logger.info("Approval ticket created", {
        id: ticket.id,
        service: serviceId,
        actionId,
        target: ticket.target
      });
    } catch {}
    return {
      ok: false,
      needsApproval: true,
      ticket,
      message: formatApprovalMessage(ticket)
    };
  }

  try {
    const result = await handler.call(connector, input.payload || {});
    return { ok: result?.ok !== false, data: result?.data, raw: result, actionId };
  } catch (err) {
    return { ok: false, reason: redactSecrets(err.message) };
  }
}

// ─────────────────────────────────────────────
// Approval lifecycle helpers
// ─────────────────────────────────────────────

export async function approveById({ id, userId } = {}) {
  const result = await resolveApproval(id, { decision: "approve", userId });
  if (!result.ok) return { ok: false, reason: result.reason };
  const ticket = result.ticket;

  try {
    await logger.info("Approval approved", { id: ticket.id, service: ticket.service, actionId: ticket.actionId });
  } catch {}

  // Special-case: actionId "git:push" / "git:push-force" / etc. tidak punya
  // connector handler langsung — caller (commands.js) yang jalankan git push
  // via terminal setelah approve. Kita kembalikan ticket apa adanya.
  const [serviceId, actionKey] = ticket.actionId.split(":");
  if (serviceId === "git" || serviceId === "deploy" || serviceId === "system" || serviceId === "fs" || serviceId === "credential" || serviceId === "session" || serviceId === "npm" || serviceId === "terminal") {
    return { ok: true, ticket, runByConnector: false };
  }

  // Map policy actionId ke handler key di connector. Default: pakai apa-adanya.
  const handlerKey = actionIdToHandler(ticket.actionId);
  const exec = await executeAction({
    service: serviceId,
    action: handlerKey,
    actionId: ticket.actionId,
    payload: ticket.payload,
    skipApproval: true,
    userId,
    label: ticket.action,
    target: ticket.target
  });
  return { ok: exec.ok, ticket, exec, runByConnector: true };
}

export async function rejectById({ id, userId } = {}) {
  const result = await resolveApproval(id, { decision: "reject", userId });
  if (!result.ok) return { ok: false, reason: result.reason };
  try {
    await logger.info("Approval rejected", { id: result.ticket.id, actionId: result.ticket.actionId });
  } catch {}
  return { ok: true, ticket: result.ticket };
}

export async function findApproval(id) {
  return getApproval(id);
}

function actionIdToHandler(actionId) {
  const map = {
    "github:create_issue": "createIssue",
    "github:create_repo": "createRepo",
    "github:create_pr": "createPullRequest",
    "github:merge_pr": "mergePullRequest",
    "github:create_release": "createRelease",
    "github:delete_repo": "deleteRepo",
    "github:update_secret": "updateSecret",
    "github:delete_branch": "deleteBranch",
    "discord:send_message_unallowed": "sendMessage",
    "discord:send_message_allowed": "sendMessage",
    "discord:mention_everyone": "sendMessage",
    "x:post_tweet": "postTweet",
    "x:delete_tweet": "deleteTweet"
  };
  return map[actionId] || actionId.split(":")[1];
}

export { formatApprovalMessage, requiresApproval };
