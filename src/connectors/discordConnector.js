// ─────────────────────────────────────────────
// discordConnector.js — Discord bot connector via discord.js (REST only).
//
// Tujuan: kirim status build/test/notif ke channel allowlist. Kita TIDAK
// jalanin gateway full-time — cukup REST API supaya hemat resource & gak
// nge-block proses bot Telegram.
// ─────────────────────────────────────────────

import { REST, Routes } from "discord.js";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { containsLikelySecret, redactSecrets, maskSecret } from "../utils/security.js";

const SAFE_ACTIONS = [
  "ping",
  "get_identity",
  "list_allowed_channels",
  "send_message_allowed"
];

const DANGEROUS_ACTIONS = [
  "send_message_unallowed",
  "mention_everyone",
  "delete_message",
  "kick_member",
  "ban_member",
  "update_role",
  "update_permission",
  "bulk_send"
];

let rest = null;
let lastIdentity = null;

function getRest() {
  if (!config.enableDiscordConnector) {
    throw new Error("Discord connector dimatikan. Set ENABLE_DISCORD_CONNECTOR=true di .env.");
  }
  if (!String(config.discordBotToken || "").trim()) {
    throw new Error("DISCORD_BOT_TOKEN belum diisi di .env.");
  }
  if (!rest) {
    rest = new REST({ version: "10", timeout: config.connectorTimeoutMs }).setToken(config.discordBotToken);
  }
  return rest;
}

function refreshClient() {
  rest = null;
  lastIdentity = null;
}

function isEnabled() {
  return config.enableDiscordConnector;
}

function describeStatus() {
  return {
    enabled: config.enableDiscordConnector,
    hasCredential: Boolean(String(config.discordBotToken || "").trim()),
    tokenPreview: maskSecret(config.discordBotToken),
    allowedGuildId: config.discordAllowedGuildId || null,
    allowedChannelIds: config.discordAllowedChannelIds || [],
    lastIdentity: lastIdentity ? `${lastIdentity.username}#${lastIdentity.discriminator || "0"}` : null
  };
}

function envHelp() {
  return [
    "Isi `.env` dengan:",
    "`ENABLE_DISCORD_CONNECTOR=true`",
    "`DISCORD_BOT_TOKEN=`  (Bot token dari Discord Developer Portal)",
    "`DISCORD_ALLOWED_GUILD_ID=xxx`",
    "`DISCORD_ALLOWED_CHANNEL_IDS=ch1,ch2`  (channel yang boleh dikirimi pesan tanpa approval)",
    "Jangan paste token di chat. Edit `.env` langsung."
  ].join("\n");
}

function isChannelAllowed(channelId) {
  if (!channelId) return false;
  const list = config.discordAllowedChannelIds || [];
  return list.includes(String(channelId));
}

async function safeRest(fn) {
  try {
    const client = getRest();
    const data = await fn(client);
    return { ok: true, data };
  } catch (err) {
    const status = err?.status || err?.code || null;
    const message = redactSecrets(err?.message || String(err));
    try {
      await logger.warn("Discord connector error", { status, error: message });
    } catch {}
    return { ok: false, status, error: message };
  }
}

// ─────────────────────────────────────────────
// Public connector API
// ─────────────────────────────────────────────

export const discordConnector = {
  id: "discord",
  label: "Discord",
  allowedActions: SAFE_ACTIONS.slice(),
  dangerousActions: DANGEROUS_ACTIONS.slice(),

  isEnabled,
  refresh: refreshClient,
  envHelp,
  getStatus: describeStatus,
  isChannelAllowed,

  async testConnection() {
    if (!isEnabled()) {
      return { ok: false, reason: "Discord connector dimatikan.", help: envHelp() };
    }
    if (!String(config.discordBotToken || "").trim()) {
      return { ok: false, reason: "DISCORD_BOT_TOKEN kosong.", help: envHelp() };
    }
    const res = await safeRest((c) => c.get(Routes.user("@me")));
    if (!res.ok) return { ok: false, reason: res.error, status: res.status };
    lastIdentity = res.data;
    return {
      ok: true,
      identity: {
        id: res.data.id,
        username: res.data.username,
        bot: Boolean(res.data.bot)
      },
      allowedChannelCount: (config.discordAllowedChannelIds || []).length
    };
  },

  async getIdentity() {
    const res = await safeRest((c) => c.get(Routes.user("@me")));
    if (res.ok) lastIdentity = res.data;
    return res;
  },

  async getAllowedChannels() {
    const ids = config.discordAllowedChannelIds || [];
    const channels = [];
    for (const id of ids) {
      const res = await safeRest((c) => c.get(Routes.channel(id)));
      if (res.ok) {
        channels.push({
          id: res.data.id,
          name: res.data.name,
          type: res.data.type,
          guildId: res.data.guild_id || null
        });
      } else {
        channels.push({ id, error: res.error });
      }
    }
    return { ok: true, channels };
  },

  async listAllowedChannels() {
    return this.getAllowedChannels();
  },

  /**
   * Kirim pesan ke channel. Caller bertanggung jawab cek allowlist + approval
   * untuk channel di luar allowlist (lihat connectorManager.executeAction).
   */
  async sendMessage({ channelId, content, allowEveryone = false }) {
    if (!channelId) return { ok: false, error: "channelId wajib." };
    if (!content || !String(content).trim()) return { ok: false, error: "content kosong." };
    if (containsLikelySecret(content)) return { ok: false, error: "content mengandung secret/token dan tidak dikirim." };
    if (!allowEveryone && /@(everyone|here)\b/i.test(String(content))) {
      return { ok: false, error: "@everyone/@here butuh approval eksplisit." };
    }
    const safeContent = String(content).slice(0, 2000);
    return safeRest((c) =>
      c.post(Routes.channelMessages(String(channelId)), { body: { content: safeContent } })
    );
  }
};
