// ─────────────────────────────────────────────
// xConnector.js — X/Twitter connector via twitter-api-v2.
//
// Default behaviour: post WAJIB approval. Untuk update yang bersifat publik,
// kita prioritaskan jalur "draft" — tweet disusun dulu, user approve via
// /approve <id>, baru dipost.
// ─────────────────────────────────────────────

import { TwitterApi } from "twitter-api-v2";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { redactSecrets, maskSecret } from "../utils/security.js";

const SAFE_ACTIONS = ["ping", "get_me", "read_profile", "read_status", "draft_post"];

const DANGEROUS_ACTIONS = [
  "post_tweet",
  "reply_public",
  "delete_tweet",
  "follow",
  "unfollow",
  "dm",
  "bulk_like",
  "bulk_retweet",
  "update_profile"
];

let userClient = null;
let appClient = null;
let lastIdentity = null;

function hasUserContext() {
  return Boolean(
    String(config.xApiKey || "").trim() &&
    String(config.xApiSecret || "").trim() &&
    String(config.xAccessToken || "").trim() &&
    String(config.xAccessSecret || "").trim()
  );
}

function hasAppContext() {
  return Boolean(String(config.xBearerToken || "").trim());
}

function getUserClient() {
  if (!config.enableXConnector) {
    throw new Error("X connector dimatikan. Set ENABLE_X_CONNECTOR=true di .env.");
  }
  if (!hasUserContext()) {
    throw new Error("X user context belum lengkap (API_KEY/API_SECRET/ACCESS_TOKEN/ACCESS_SECRET).");
  }
  if (!userClient) {
    userClient = new TwitterApi({
      appKey: config.xApiKey,
      appSecret: config.xApiSecret,
      accessToken: config.xAccessToken,
      accessSecret: config.xAccessSecret
    });
  }
  return userClient;
}

function getAppClient() {
  if (!config.enableXConnector) {
    throw new Error("X connector dimatikan. Set ENABLE_X_CONNECTOR=true di .env.");
  }
  if (!hasAppContext()) {
    throw new Error("X bearer token belum diisi (X_BEARER_TOKEN).");
  }
  if (!appClient) {
    appClient = new TwitterApi(config.xBearerToken);
  }
  return appClient;
}

function refreshClient() {
  userClient = null;
  appClient = null;
  lastIdentity = null;
}

function isEnabled() {
  return config.enableXConnector;
}

function describeStatus() {
  return {
    enabled: config.enableXConnector,
    hasUserContext: hasUserContext(),
    hasAppContext: hasAppContext(),
    apiKeyPreview: maskSecret(config.xApiKey),
    accessTokenPreview: maskSecret(config.xAccessToken),
    bearerPreview: maskSecret(config.xBearerToken),
    lastIdentity: lastIdentity ? `@${lastIdentity.username}` : null
  };
}

function envHelp() {
  return [
    "Isi `.env` dengan:",
    "`ENABLE_X_CONNECTOR=true`",
    "`X_API_KEY=`",
    "`X_API_SECRET=`",
    "`X_ACCESS_TOKEN=`",
    "`X_ACCESS_SECRET=`",
    "`X_BEARER_TOKEN=`  (opsional, buat read-only)",
    "Jangan paste token di chat. Edit `.env` langsung."
  ].join("\n");
}

async function safeCall(fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    const status = err?.code || err?.status || null;
    const message = redactSecrets(err?.data?.detail || err?.message || String(err));
    try {
      await logger.warn("X connector error", { status, error: message });
    } catch {}
    return { ok: false, status, error: message };
  }
}

// ─────────────────────────────────────────────
// Public connector API
// ─────────────────────────────────────────────

export const xConnector = {
  id: "x",
  label: "X / Twitter",
  allowedActions: SAFE_ACTIONS.slice(),
  dangerousActions: DANGEROUS_ACTIONS.slice(),

  isEnabled,
  refresh: refreshClient,
  envHelp,
  getStatus: describeStatus,

  async testConnection() {
    if (!isEnabled()) {
      return { ok: false, reason: "X connector dimatikan.", help: envHelp() };
    }
    if (!hasUserContext() && !hasAppContext()) {
      return { ok: false, reason: "X credential belum diisi.", help: envHelp() };
    }
    if (hasUserContext()) {
      const res = await safeCall(async () => {
        const client = getUserClient();
        const me = await client.v2.me();
        return me?.data;
      });
      if (!res.ok) return { ok: false, reason: res.error, status: res.status };
      lastIdentity = res.data;
      return { ok: true, identity: { id: res.data?.id, username: res.data?.username, name: res.data?.name } };
    }
    // App-only: just fetch a known public endpoint to verify bearer.
    const res = await safeCall(async () => {
      const client = getAppClient();
      // Use rate-limit endpoint as a cheap check. If fails, fallback.
      try {
        return await client.v1.get("application/rate_limit_status.json");
      } catch {
        return { mode: "bearer-only" };
      }
    });
    return res.ok ? { ok: true, identity: null, mode: "bearer-only" } : { ok: false, reason: res.error };
  },

  async getMe() {
    if (!hasUserContext()) return { ok: false, error: "X user context dibutuhkan." };
    const res = await safeCall(async () => {
      const client = getUserClient();
      const me = await client.v2.me();
      return me?.data;
    });
    if (res.ok) lastIdentity = res.data;
    return res;
  },

  async readProfile() {
    return this.getMe();
  },

  async readStatus() {
    const status = describeStatus();
    return { ok: true, data: status };
  },

  /**
   * Compose draft post — tidak publish, cuma return preview text.
   * Caller WAJIB lewat approval untuk publish.
   */
  buildDraft({ text }) {
    const safeText = String(text || "").trim();
    if (!safeText) return { ok: false, error: "Isi tweet kosong." };
    if (safeText.length > 280) {
      return {
        ok: true,
        warning: "Tweet melebihi 280 karakter. Mode v2 mendukung long-form, tapi sebagian akun masih dibatasi 280.",
        draft: safeText
      };
    }
    return { ok: true, draft: safeText };
  },

  async postTweet({ text }) {
    if (!hasUserContext()) return { ok: false, error: "X user context dibutuhkan untuk posting." };
    const safeText = String(text || "").trim();
    if (!safeText) return { ok: false, error: "Isi tweet kosong." };
    return safeCall(async () => {
      const client = getUserClient();
      const res = await client.v2.tweet(safeText);
      return res?.data;
    });
  },

  async deleteTweet({ id }) {
    if (!hasUserContext()) return { ok: false, error: "X user context dibutuhkan." };
    if (!id) return { ok: false, error: "id wajib." };
    return safeCall(async () => {
      const client = getUserClient();
      const res = await client.v2.deleteTweet(String(id));
      return res?.data;
    });
  },

  async getMentions({ maxResults = 5 } = {}) {
    if (!hasUserContext()) return { ok: false, error: "X user context dibutuhkan." };
    return safeCall(async () => {
      const client = getUserClient();
      const me = await client.v2.me();
      if (!me?.data?.id) throw new Error("Gagal ambil user id.");
      const res = await client.v2.userMentionTimeline(me.data.id, {
        max_results: Math.min(Math.max(parseInt(maxResults, 10) || 5, 5), 100)
      });
      return res?.data?.data || [];
    });
  }
};
