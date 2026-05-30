// ─────────────────────────────────────────────
// httpClient.js — wrapper di atas axios untuk connector.
//
// Tujuan utama:
//   1. Timeout default + retry kecil untuk error transient (429/5xx/network).
//   2. Header secret di-mask saat error/log, tidak pernah bocor ke Telegram.
//   3. Tetap modular: tiap connector boleh kasih custom baseURL & header.
// ─────────────────────────────────────────────

import axios from "axios";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { redactSecrets, maskSecret } from "../utils/security.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function maskHeaders(headers = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    const value = String(raw ?? "");
    if (
      lower === "authorization" ||
      lower === "proxy-authorization" ||
      lower === "cookie" ||
      lower === "set-cookie" ||
      lower === "x-api-key" ||
      lower === "x-auth-token" ||
      lower === "api-key"
    ) {
      out[key] = maskSecret(value, { keepStart: 4, keepEnd: 4 }) || "[REDACTED]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function safeErrorPayload(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  let body = "";
  if (data) {
    try {
      body = typeof data === "string" ? data : JSON.stringify(data);
    } catch {
      body = "[unserializable response body]";
    }
  }
  return {
    status: status || null,
    message: redactSecrets(err?.message || String(err)),
    body: body ? redactSecrets(body).slice(0, 1500) : ""
  };
}

/**
 * Build axios instance untuk connector.
 *
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {object} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRetries]
 * @param {string} [opts.label] — untuk log
 */
export function createHttpClient({
  baseURL,
  headers = {},
  timeoutMs,
  maxRetries,
  label = "http"
} = {}) {
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : config.connectorTimeoutMs;
  const retries = Number.isFinite(maxRetries) ? maxRetries : config.connectorMaxRetries;

  const instance = axios.create({
    baseURL,
    timeout,
    headers: { Accept: "application/json", ...headers },
    // Selalu return response biar kita yang inspect status; throw manual.
    validateStatus: () => true
  });

  async function request(method, url, { params, data, headers: extra, timeout: perCallTimeout } = {}) {
    const opts = {
      method,
      url,
      params,
      data,
      headers: extra ? { ...headers, ...extra } : undefined,
      timeout: perCallTimeout || timeout
    };

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await instance.request(opts);
        if (res.status >= 200 && res.status < 300) {
          return { ok: true, status: res.status, data: res.data, headers: res.headers };
        }
        // Non-2xx: decide retry
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        const safeBody = redactSecrets(typeof res.data === "string" ? res.data : JSON.stringify(res.data || {}));
        return {
          ok: false,
          status: res.status,
          data: res.data,
          error: `HTTP ${res.status}: ${safeBody.slice(0, 800)}`
        };
      } catch (err) {
        lastErr = err;
        const transient = isTransientError(err);
        if (!transient || attempt >= retries) break;
        await sleep(backoffMs(attempt));
      }
    }

    const payload = safeErrorPayload(lastErr || new Error("Unknown HTTP error"));
    try {
      await logger.warn(`${label} request failed`, {
        method,
        url,
        status: payload.status,
        error: payload.message
      });
    } catch {}
    return {
      ok: false,
      status: payload.status,
      error: payload.message,
      body: payload.body
    };
  }

  return {
    request,
    get: (url, opts) => request("GET", url, opts),
    post: (url, data, opts) => request("POST", url, { ...(opts || {}), data }),
    delete: (url, opts) => request("DELETE", url, opts),
    patch: (url, data, opts) => request("PATCH", url, { ...(opts || {}), data }),
    put: (url, data, opts) => request("PUT", url, { ...(opts || {}), data }),
    raw: instance,
    debugHeaders() {
      return maskHeaders(headers);
    }
  };
}

function isTransientError(err) {
  if (!err) return false;
  const code = String(err.code || "").toUpperCase();
  if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ECONNABORTED"].includes(code)) return true;
  const msg = String(err.message || "").toLowerCase();
  return /timeout|network|socket hang up|econn/.test(msg);
}

function backoffMs(attempt) {
  return Math.min(1000 * 2 ** attempt, 6000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
