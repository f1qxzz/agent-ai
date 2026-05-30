import TelegramBot from "node-telegram-bot-api";
import { assertConfigReady, config, ensureAppDirectories } from "./config.js";
import { logger } from "./logger.js";
import { registerCommands } from "../commands/commands.js";
import { ensureActiveProject, stopAllProcesses, getWorkspaceDir, getActiveProjectPath, listRunningProcesses, processEvents } from "../system/processManager.js";
import chalk from "chalk";
import figlet from "figlet";
import boxen from "boxen";
import gradient from "gradient-string";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { redactSecrets } from "../utils/security.js";

export function printTerminalBanner() {
  console.clear();

  const bannerProjectDir = getActiveProjectPath() || config.projectRoot || config.projectDir;
  const bannerProjectName = bannerProjectDir ? bannerProjectDir.split(/[\\/]/).pop() : "(none)";
  const bannerEngineText = `${config.aiProvider.toUpperCase()} / ${config.aiModel}`;
  const bannerPlatform = `${os.type()} ${os.release()} (${os.arch()})`;

  console.log(chalk.cyan.bold(`${config.agentName} Telegram Familiar`));
  console.log(chalk.gray("=".repeat(72)));
  console.log(`${chalk.cyan("Owner")}      ${config.agentOwner}`);
  console.log(`${chalk.cyan("Platform")}   Telegram polling`);
  console.log(`${chalk.cyan("Project")}    ${bannerProjectName}`);
  console.log(`${chalk.cyan("Runtime")}    ${bannerPlatform}`);
  console.log(`${chalk.cyan("AI")}         ${bannerEngineText}`);
  console.log(`${chalk.cyan("Safety")}     PROJECT_ROOT scoped, approval guarded`);
  console.log(chalk.gray("=".repeat(72)));
  console.log(chalk.green("ONLINE - awaiting Telegram instructions"));
  console.log(chalk.gray("Watch mode is active when started through npm run start.\n"));
  return;

  // ── ASCII Art ──
  const asciiArt = figlet.textSync("f1qxz", {
    font: "ANSI Shadow",
    horizontalLayout: "fitted",
    verticalLayout: "default",
    width: 140,
    whitespaceBreak: true
  });

  const neonGradient = gradient(["#00f2fe", "#4facfe", "#a855f7", "#ec4899"]);
  console.log(neonGradient.multiline(asciiArt));

  // ── Hardware Stats ──
  const cpuModel = os.cpus()[0]?.model?.replace(/\(R\)|\(TM\)/gi, "").replace(/\s+/g, " ").trim() || "Unknown CPU";
  const cpuCores = os.cpus().length;
  const platform = `${os.type()} ${os.release()} (${os.arch()})`;

  let gpuInfo = "Unknown GPU";
  try {
    if (process.platform === "win32") {
      const wmicOutput = execSync('wmic path win32_VideoController get name,AdapterRAM', { stdio: 'pipe' }).toString();
      const lines = wmicOutput.split('\n').map(l => l.trim()).filter(l => l && !l.toLowerCase().includes('adapterram'));
      
      let bestGpu = lines[0] || "Unknown GPU";
      for (const line of lines) {
        if (line.toLowerCase().includes("nvidia") || line.toLowerCase().includes("amd") || line.toLowerCase().includes("radeon")) {
          bestGpu = line;
          break;
        }
      }
      
      const match = bestGpu.match(/^(\d+)\s+(.+)$/);
      if (match) {
        const vramGb = Math.round(parseInt(match[1], 10) / 1024 / 1024 / 1024);
        gpuInfo = `${match[2].trim()} (${vramGb} GB VRAM)`;
      } else {
        // Just in case wmic output order changes
        const matchReverse = bestGpu.match(/^(.+?)\s+(\d+)$/);
        if (matchReverse) {
          const vramGb = Math.round(parseInt(matchReverse[2], 10) / 1024 / 1024 / 1024);
          gpuInfo = `${matchReverse[1].trim()} (${vramGb} GB VRAM)`;
        } else {
          gpuInfo = bestGpu.trim();
        }
      }
    }
  } catch (e) {}

  // ── RAM Bar ──
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = Math.round((usedMem / totalMem) * 100);
  const totalGb = (totalMem / 1024 / 1024 / 1024).toFixed(1);
  const usedGb = (usedMem / 1024 / 1024 / 1024).toFixed(1);
  const filledBlocks = Math.round(memPct / 10);
  const ramBar = "█".repeat(filledBlocks) + "░".repeat(10 - filledBlocks);
  const ramColor = memPct > 80 ? chalk.red : chalk.greenBright;

  // ── Session Stats ──
  const projectDir = getActiveProjectPath();
  const projectName = projectDir ? projectDir.split(/[\\/]/).pop() : "(none)";
  const engineText = `${config.aiProvider.toUpperCase()} · ${config.aiModel}`;

  const pad = (label, len = 12) => label.padEnd(len);

  const uiBox = [
    `${chalk.cyan.bold("║ SYSTEM OP ")} ${chalk.gray("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`,
    `${chalk.cyan("║")}  ${chalk.gray("💻")} ${chalk.cyan(pad("OS"))} ${chalk.white(platform)}`,
    `${chalk.cyan("║")}  ${chalk.gray("🧠")} ${chalk.cyan(pad("CPU"))} ${chalk.white(`${cpuModel} (${cpuCores} Threads)`)}`,
    `${chalk.cyan("║")}  ${chalk.gray("🎮")} ${chalk.cyan(pad("GPU"))} ${chalk.white(gpuInfo)}`,
    `${chalk.cyan("║")}  ${chalk.gray("📊")} ${chalk.cyan(pad("RAM"))} ${ramColor(`[${ramBar}] ${memPct}%`)} ${chalk.gray(`(${usedGb} / ${totalGb} GB)`)}`,
    `${chalk.cyan.bold("║ ENVIRONMENT ")} ${chalk.gray("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`,
    `${chalk.cyan("║")}  ${chalk.gray("🎯")} ${chalk.cyan(pad("Target"))} ${chalk.yellowBright.bold(projectName)}`,
    `${chalk.cyan("║")}  ${chalk.gray("🤖")} ${chalk.cyan(pad("Core AI"))} ${chalk.magentaBright(engineText)}`,
    `${chalk.cyan("║")}  ${chalk.gray("🔓")} ${chalk.cyan(pad("Privilege"))} ${chalk.greenBright.bold("⬤ ROOT / UNRESTRICTED")}`,
    `${chalk.cyan("║")}  ${chalk.gray("🔌")} ${chalk.cyan(pad("Uplink"))}  ${chalk.blueBright("Secured (Telegram API)")}`,
  ].join("\n");

  console.log(
    boxen(uiBox, {
      padding: { top: 0, bottom: 0, left: 1, right: 2 },
      margin: { top: 1, bottom: 1, left: 2, right: 0 },
      borderStyle: "double",
      borderColor: "cyan",
      title: " f1qxzz ",
      titleAlignment: "center"
    })
  );

  console.log(`  ${chalk.greenBright("▶")} ${chalk.greenBright.bold("SYSTEM ONLINE")} ${chalk.gray("— Awaiting instructions...")}`);
  console.log(`  ${chalk.cyan("⚡")} ${chalk.cyan.bold("HOT-RELOAD ACTIVE")} ${chalk.gray("— Auto-applying updates live on file save!")}\n`);
}

function isMarkdownParseError(error) {
  const msg = String(error?.message || "");
  return /can't parse entities|parse_mode|markdown/i.test(msg);
}

function stripMarkdownForFallback(text) {
  return String(text || "")
    .replace(/\\([_*`\[\]])/g, "$1")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/`/g, "")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2");
}

function clampUtf8(text, maxBytes = 64) {
  let value = String(text || "");
  while (Buffer.byteLength(value, "utf8") > maxBytes && value.length > 0) {
    value = value.slice(0, -1);
  }
  return value || "noop";
}

function sanitizeReplyMarkup(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return replyMarkup;
  const inline_keyboard = replyMarkup.inline_keyboard.map((row) => {
    if (!Array.isArray(row)) return [];
    return row.map((btn) => {
      if (!btn || typeof btn !== "object") return btn;
      if (Object.prototype.hasOwnProperty.call(btn, "callback_data")) {
        const next = { ...btn };
        next.callback_data = clampUtf8(next.callback_data, 64);
        return next;
      }
      return btn;
    });
  });
  return { ...replyMarkup, inline_keyboard };
}

function sanitizeTelegramOptions(options = {}) {
  const safe = { ...(options || {}) };
  if (safe.reply_markup) safe.reply_markup = sanitizeReplyMarkup(safe.reply_markup);
  return safe;
}

function isTransientNetworkError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return [
    "econnreset",
    "etimedout",
    "enotfound",
    "eai_again",
    "network",
    "socket hang up",
    "polling error",
    "efatal"
  ].some((k) => msg.includes(k));
}

function installTelegramGuards(bot) {
  if (bot.__guardsInstalled) return;
  bot.__guardsInstalled = true;

  const originalSendMessage = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, options = {}) => {
    const safeOptions = sanitizeTelegramOptions(options);
    const safeText = redactSecrets(String(text || ""));
    try {
      return await originalSendMessage(chatId, safeText, safeOptions);
    } catch (error) {
      if (safeOptions.parse_mode && isMarkdownParseError(error)) {
        const fallback = { ...safeOptions };
        delete fallback.parse_mode;
        return originalSendMessage(chatId, stripMarkdownForFallback(safeText), fallback);
      }
      throw error;
    }
  };

  if (typeof bot.editMessageText === "function") {
    const originalEditMessageText = bot.editMessageText.bind(bot);
    bot.editMessageText = async (text, options = {}) => {
      const safeOptions = sanitizeTelegramOptions(options);
      const safeText = redactSecrets(String(text || ""));
      try {
        return await originalEditMessageText(safeText, safeOptions);
      } catch (error) {
        if (safeOptions.parse_mode && isMarkdownParseError(error)) {
          const fallback = { ...safeOptions };
          delete fallback.parse_mode;
          return originalEditMessageText(stripMarkdownForFallback(safeText), fallback);
        }
        throw error;
      }
    };
  }
}

async function bootstrap() {
  await ensureAppDirectories();
  assertConfigReady();
  await ensureActiveProject();

  const bot = new TelegramBot(config.telegramBotToken, {
    polling: {
      interval: 500,
      autoStart: true,
      params: {
        timeout: 10
      }
    }
  });

  installTelegramGuards(bot);

  registerCommands(bot);

  let pollingFailureCount = 0;
  let pollingRecoveryTimer = null;
  let pollingRecoveryInFlight = false;

  const schedulePollingRecovery = async (error) => {
    if (!isTransientNetworkError(error)) return;
    if (pollingRecoveryTimer || pollingRecoveryInFlight) return;

    const delayMs = Math.min(30000, 1000 * (2 ** Math.min(pollingFailureCount, 5)));
    await logger.warn("Telegram polling transient error, scheduling recovery", {
      error: error.message,
      delayMs,
      failures: pollingFailureCount
    });

    pollingRecoveryTimer = setTimeout(async () => {
      pollingRecoveryTimer = null;
      pollingRecoveryInFlight = true;
      try {
        await bot.stopPolling().catch(() => {});
        await bot.startPolling();
        pollingFailureCount = 0;
        await logger.info("Telegram polling recovered", { delayMs });
      } catch (recoveryError) {
        pollingFailureCount += 1;
        await logger.error("Telegram polling recovery failed", {
          error: recoveryError.message,
          failures: pollingFailureCount
        });
      } finally {
        pollingRecoveryInFlight = false;
      }
    }, delayMs);
  };

  bot.on("message", () => {
    pollingFailureCount = 0;
  });

  bot.on("polling_error", async (error) => {
    pollingFailureCount += 1;
    await logger.error("Telegram polling error", { error: error.message });
    await schedulePollingRecovery(error);
  });

  bot.on("webhook_error", async (error) => {
    await logger.error("Telegram webhook error", { error: error.message });
    await schedulePollingRecovery(error);
  });

  processEvents.on("crash", async (record) => {
    try {
      const outputPreview = record.output ? `\nOutput terakhir:\n${record.output.slice(-500)}` : "";
      await bot.sendMessage(config.telegramUserId, `\uD83D\uDEA8 *PROSES CRASH*\n\nProses \`${record.label}\` (PID: ${record.pid}) mati tidak normal (Exit Code: ${record.exitCode}).\nCommand: \`${record.command}\`${outputPreview}`, { parse_mode: "Markdown" });
    } catch(e) {}
  });

  printTerminalBanner();

  const shutdown = async (signal) => {
    await logger.warn(`Menerima ${signal}, menghentikan bot dan process aktif.`);
    await stopAllProcesses();
    await bot.stopPolling();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  bootstrap().catch(async (error) => {
    await ensureAppDirectories().catch(() => {});
    await logger.error("Gagal menjalankan bot", { error: error.message, stack: error.stack });
    console.error(`Gagal menjalankan bot: ${error.message}`);
    process.exit(1);
  });
}
