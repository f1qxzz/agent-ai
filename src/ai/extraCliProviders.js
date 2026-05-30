import { config } from "../core/config.js";
import { checkCliBinary, runCliBinary } from "./cliRunner.js";

/**
 * Provider runtime yang dipakai project ini:
 * - Gemini API (GEMINI_API_KEY)
 * - Kiro CLI + API key (KIRO_API_KEY)
 */

export const PRESET_GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash"
];

export const PRESET_KIRO_MODELS = [
  "claude-opus-4.7",
  "claude-sonnet-4.6",
  "qwen3-coder-next",
  "auto"
];

export function checkKiroCli({ timeoutMs = 4000 } = {}) {
  const command = config.kiroCliCommand || "kiro-cli";
  return checkCliBinary(command, { timeoutMs });
}

function sanitizeModelName(model) {
  if (!model) return "";
  return String(model)
    .trim()
    .replace(/^[\s`'"]+|[\s`'"]+$/g, "")
    .replace(/^\/+|\/+$/g, "");
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function normalizeGeminiModel(model) {
  const clean = sanitizeModelName(model).replace(/^google\//i, "");
  if (!clean) return "gemini-2.5-pro";
  return clean;
}

function normalizeKiroModel(model) {
  const clean = sanitizeModelName(model).replace(/^kiro\//i, "");
  if (!clean) return "auto";
  return clean;
}

function isGeminiLikeModel(model) {
  const value = String(model || "").toLowerCase();
  return value.startsWith("gemini") || value.startsWith("google/");
}

function isKiroLikeModel(model) {
  const value = String(model || "").toLowerCase();
  return value.startsWith("claude") || value.startsWith("qwen") || value.startsWith("auto") || value.startsWith("kiro/");
}

function resolveModelForProvider(provider, requestedModel) {
  const model = sanitizeModelName(requestedModel || config.aiModel);
  if (provider === "gemini-apikey") {
    if (!model) return "gemini-2.5-pro";
    if (isGeminiLikeModel(model)) return normalizeGeminiModel(model);
    if (PRESET_GEMINI_MODELS.includes(model)) return model;
    return "gemini-2.5-pro";
  }
  if (provider === "kiro-apikey") {
    if (!model) return "claude-opus-4.7";
    if (isKiroLikeModel(model)) return normalizeKiroModel(model);
    if (PRESET_KIRO_MODELS.includes(model)) return model;
    return "claude-opus-4.7";
  }
  return model || config.aiModel;
}

function extractGeminiText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const chunks = [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
    if (chunks.length > 0) break;
  }
  return chunks.join("\n").trim();
}

function extractKiroText(raw) {
  const cleaned = stripAnsi(raw).replace(/\r/g, "");
  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const collected = [];
  for (const line of lines) {
    if (/credits:/i.test(line)) break;
    if (/^>\s*/.test(line)) {
      const value = line.replace(/^>\s*/, "").trim();
      if (value) collected.push(value);
      continue;
    }
    if (/^\?25[lh]$/.test(line)) continue;
    if (/^\d+G$/.test(line)) continue;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

export async function runGeminiApi(prompt, { model, timeoutMs } = {}) {
  const apiKey = String(config.geminiApiKey || "").trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum diisi di .env.");
  }

  const geminiModel = normalizeGeminiModel(model || config.aiModel);
  const controller = new AbortController();
  const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : (config.aiProviderTimeoutMs || 180000);
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: String(prompt || "") }]
          }
        ]
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch {}

    if (!response.ok) {
      const detail = payload?.error?.message || raw || `HTTP ${response.status}`;
      throw new Error(`Gemini API error (${response.status}): ${detail}`);
    }

    const text = extractGeminiText(payload);
    if (!text) {
      const reason = payload?.candidates?.[0]?.finishReason || payload?.promptFeedback?.blockReason || "empty response";
      throw new Error(`Gemini API tidak mengembalikan teks (${reason}).`);
    }
    return text;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Gemini API timeout setelah ${effectiveTimeout}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function runKiroCli(prompt, { model, agent, timeoutMs } = {}) {
  const apiKey = String(config.kiroApiKey || "").trim();
  if (!apiKey) {
    throw new Error("KIRO_API_KEY belum diisi di .env.");
  }

  const kiroModel = normalizeKiroModel(model || config.aiModel);
  const command = config.kiroCliCommand || "kiro-cli";
  const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : (config.aiProviderTimeoutMs || 180000);
  const args = ["chat", "--no-interactive", "--model", kiroModel];
  if (agent && String(agent).trim()) args.push("--agent", String(agent).trim());

  const raw = await runCliBinary({
    command,
    args,
    prompt: String(prompt || ""),
    timeoutMs: effectiveTimeout,
    cwd: config.appRoot,
    label: "Kiro CLI"
  });

  const text = extractKiroText(raw);
  if (!text) throw new Error("Kiro CLI mengembalikan respons kosong.");
  return text;
}

export async function runSelectedProvider(prompt, { model, timeoutMs, agent, onFallback } = {}) {
  const providerCall = {
    "gemini-apikey": (resolvedModel) => runGeminiApi(prompt, { model: resolvedModel, timeoutMs }),
    "kiro-apikey": (resolvedModel) => runKiroCli(prompt, { model: resolvedModel, timeoutMs, agent })
  };

  const primary = String(config.aiProvider || "").trim().toLowerCase();
  if (!providerCall[primary]) {
    throw new Error(`Provider AI tidak didukung: ${config.aiProvider}`);
  }

  const configuredOrder = Array.isArray(config.fallbackProviderOrder)
    ? config.fallbackProviderOrder.filter((p) => p && providerCall[p])
    : [];
  const uniqueOrder = [primary, ...configuredOrder.filter((p) => p !== primary)];
  for (const candidate of ["gemini-apikey", "kiro-apikey"]) {
    if (!uniqueOrder.includes(candidate)) uniqueOrder.push(candidate);
  }
  const providerOrder = config.aiAutoFallback ? uniqueOrder : [primary];

  const errors = [];
  for (let i = 0; i < providerOrder.length; i++) {
    const provider = providerOrder[i];
    const resolvedModel = resolveModelForProvider(provider, model || config.aiModel);
    try {
      if (i > 0 && typeof onFallback === "function") {
        try {
          onFallback({
            type: "provider_switch",
            from: providerOrder[i - 1],
            to: provider,
            reason: "retryable_failure",
            model: resolvedModel
          });
        } catch {}
      }
      return await providerCall[provider](resolvedModel);
    } catch (err) {
      errors.push(`${provider}: ${err?.message || String(err)}`);
      const retryable = isRetryableProviderError(err);
      const hasNext = i < providerOrder.length - 1;
      if (retryable && hasNext && typeof onFallback === "function") {
        try {
          const nextProvider = providerOrder[i + 1];
          const nextModel = resolveModelForProvider(nextProvider, model || config.aiModel);
          onFallback({
            type: "provider_retry",
            from: provider,
            to: nextProvider,
            reason: err?.message || String(err),
            model: nextModel
          });
        } catch {}
      }
      if (!config.aiAutoFallback || !retryable || !hasNext) break;
    }
  }

  if (errors.length === 1) {
    throw new Error(errors[0]);
  }
  throw new Error(`Semua provider gagal: ${errors.join(" | ")}`);
}

function isRetryableProviderError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  if (!msg) return false;
  return [
    "timeout",
    "timed out",
    "429",
    "404",
    "quota",
    "rate limit",
    "not found",
    "not supported",
    "unsupported",
    "overloaded",
    "unavailable",
    "temporary",
    "respons kosong",
    "empty response",
    "socket hang up",
    "econnreset",
    "etimedout",
    "service unavailable"
  ].some((k) => msg.includes(k));
}
