import fs from "fs/promises";
import { config } from "./config.js";
import { redactSecrets } from "../utils/security.js";
import chalk from "chalk";

async function appendLog(level, message, meta = {}) {
  let safeMeta = {};
  try {
    safeMeta = JSON.parse(redactSecrets(JSON.stringify(meta ?? {})));
  } catch {
    safeMeta = { note: "meta tidak bisa diserialisasi" };
  }

  const entry = {
    ts: new Date().toISOString(),
    level,
    message: redactSecrets(message),
    meta: safeMeta
  };

  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.appendFile(config.appLogFile, line, "utf8");
  } catch (error) {
    console.error("Gagal menulis app log:", error.message);
  }

  const printer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  
  const formattedTime = chalk.gray(new Date(entry.ts).toLocaleTimeString());
  let levelStr = `[${entry.level.toUpperCase()}]`;
  
  if (level === "error") levelStr = chalk.red.bold(levelStr);
  else if (level === "warn") levelStr = chalk.yellow.bold(levelStr);
  else levelStr = chalk.green.bold(levelStr);
  
  printer(`${formattedTime} ${levelStr} ${entry.message}`);
}

export const logger = {
  info(message, meta = {}) {
    return appendLog("info", message, meta);
  },
  warn(message, meta = {}) {
    return appendLog("warn", message, meta);
  },
  error(message, meta = {}) {
    return appendLog("error", message, meta);
  }
};
