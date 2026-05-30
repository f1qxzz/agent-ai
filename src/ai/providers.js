import { PRESET_GEMINI_MODELS, PRESET_KIRO_MODELS } from "./extraCliProviders.js";

export const providers = {
  "gemini-apikey": {
    id: "gemini-apikey",
    label: "Gemini API Key",
    models: PRESET_GEMINI_MODELS,
    isConfigured(cfg = {}) {
      return Boolean(cfg.geminiApiKey || process.env.GEMINI_API_KEY);
    }
  },
  "kiro-apikey": {
    id: "kiro-apikey",
    label: "Kiro API Key",
    models: PRESET_KIRO_MODELS,
    isConfigured(cfg = {}) {
      return Boolean(cfg.kiroApiKey || process.env.KIRO_API_KEY);
    }
  }
};

export function listConfiguredProviders(cfg = {}) {
  return Object.values(providers).filter((provider) => {
    try {
      return provider.isConfigured(cfg);
    } catch {
      return false;
    }
  });
}
