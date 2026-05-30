// ─────────────────────────────────────────────
// githubDeviceLogin.js — GitHub OAuth Device Flow.
//
// Flow:
//   1. POST /login/device/code → user_code + verification_uri + device_code
//   2. User buka verification_uri di browser, login pakai email+password
//      GitHub-nya, lalu masukin user_code.
//   3. Bot polling /login/oauth/access_token sampai dapet access_token.
//   4. Token disimpan ke .env (GITHUB_TOKEN), connector di-refresh.
//
// User TIDAK pernah paste password di bot. Login asli tetap di github.com.
// ─────────────────────────────────────────────

import axios from "axios";
import { config, saveConfigToEnv } from "../core/config.js";
import { logger } from "../core/logger.js";
import { redactSecrets } from "../utils/security.js";

// Default client_id GitHub CLI (`gh`). Public, dipakai juga oleh VS Code,
// boleh dipakai untuk device flow karena GitHub mengizinkan public OAuth
// app share client_id. Kalau user mau bikin sendiri, set GITHUB_OAUTH_CLIENT_ID.
const DEFAULT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_SCOPE = "repo read:user workflow";

const inFlight = new Map(); // chatId -> { abort, deviceCode, expiresAt }

function getClientId() {
  return String(process.env.GITHUB_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
}

/**
 * Start device flow.
 * Return { userCode, verificationUri, deviceCode, interval, expiresIn }.
 */
export async function startDeviceFlow({ scope = DEFAULT_SCOPE } = {}) {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error("GITHUB_OAUTH_CLIENT_ID kosong dan default fallback tidak tersedia.");
  }

  const res = await axios.post(
    DEVICE_CODE_URL,
    new URLSearchParams({ client_id: clientId, scope }),
    {
      headers: { Accept: "application/json" },
      timeout: 15000,
      validateStatus: () => true
    }
  );

  if (res.status !== 200 || !res.data?.device_code) {
    const detail = res.data?.error_description || res.data?.error || `HTTP ${res.status}`;
    throw new Error(`Gagal memulai device flow: ${redactSecrets(String(detail))}`);
  }

  return {
    deviceCode: res.data.device_code,
    userCode: res.data.user_code,
    verificationUri: res.data.verification_uri,
    verificationUriComplete: res.data.verification_uri_complete || null,
    interval: Math.max(parseInt(res.data.interval, 10) || 5, 5),
    expiresIn: parseInt(res.data.expires_in, 10) || 900
  };
}

/**
 * Poll endpoint sampai dapet token, expired, atau di-cancel.
 *
 * @param {object} input
 * @param {string} input.deviceCode
 * @param {number} input.interval     — detik antar polling
 * @param {number} input.expiresIn    — total detik sebelum device_code expired
 * @param {AbortSignal} [input.signal]
 * @param {function} [input.onTick]   — callback(stage) untuk progress
 * @returns {Promise<{ok: boolean, accessToken?: string, scope?: string, reason?: string}>}
 */
export async function pollForToken({ deviceCode, interval, expiresIn, signal, onTick }) {
  const clientId = getClientId();
  const deadline = Date.now() + Math.max(expiresIn, 60) * 1000;
  let currentInterval = Math.max(interval, 5);

  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: "Login dibatalkan." };

    await sleep(currentInterval * 1000);
    if (signal?.aborted) return { ok: false, reason: "Login dibatalkan." };
    if (typeof onTick === "function") {
      try { onTick("polling"); } catch {}
    }

    let res;
    try {
      res = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }),
        {
          headers: { Accept: "application/json" },
          timeout: 15000,
          validateStatus: () => true
        }
      );
    } catch (err) {
      // Transient: log + lanjut polling
      try { await logger.warn("Device-flow poll error (transient)", { error: err.message }); } catch {}
      continue;
    }

    const data = res.data || {};

    if (data.access_token) {
      return {
        ok: true,
        accessToken: String(data.access_token),
        scope: String(data.scope || ""),
        tokenType: String(data.token_type || "bearer")
      };
    }

    const error = String(data.error || "");
    switch (error) {
      case "authorization_pending":
        // user belum approve, lanjut polling
        continue;
      case "slow_down":
        currentInterval += 5;
        continue;
      case "expired_token":
        return { ok: false, reason: "Kode login expired. Mulai ulang dengan `login github`." };
      case "access_denied":
        return { ok: false, reason: "User menolak akses login." };
      case "incorrect_device_code":
      case "incorrect_client_credentials":
        return {
          ok: false,
          reason: `OAuth error: ${error}. Cek GITHUB_OAUTH_CLIENT_ID di .env.`
        };
      case "":
        // Empty error tapi gak ada token — anggap transient
        continue;
      default:
        return { ok: false, reason: `OAuth error: ${redactSecrets(data.error_description || error)}` };
    }
  }

  return { ok: false, reason: "Login timeout. Mulai ulang dengan `login github`." };
}

/**
 * Simpan token ke .env + aktifkan connector. Return preview state baru.
 */
export async function persistTokenToEnv(accessToken, { username = "" } = {}) {
  const updates = {
    GITHUB_TOKEN: accessToken,
    ENABLE_GITHUB_CONNECTOR: "true"
  };
  if (username) updates.GITHUB_USERNAME = username;
  await saveConfigToEnv(updates);

  // Update runtime config jadi langsung aktif tanpa restart bot.
  config.githubToken = accessToken;
  config.enableGithubConnector = true;
  if (username) config.githubUsername = username;

  // Set env var juga supaya redactSecrets pickup di runtime ini.
  process.env.GITHUB_TOKEN = accessToken;
  process.env.ENABLE_GITHUB_CONNECTOR = "true";
  if (username) process.env.GITHUB_USERNAME = username;
}

export function trackSession(chatId, sessionData) {
  inFlight.set(String(chatId), sessionData);
}

export function getSession(chatId) {
  return inFlight.get(String(chatId)) || null;
}

export function clearSession(chatId) {
  inFlight.delete(String(chatId));
}

export function activeSessions() {
  return inFlight.size;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
