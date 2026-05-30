import fs from "fs/promises";
import path from "path";
import { config } from "./config.js";
import { getLast } from "./memory.js";
import { redactSecrets, truncateOutput } from "../utils/security.js";

const skillsFile = path.join(config.dataDir, "skills.json");

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizeText(value, maxChars = 1000) {
  const text = truncateOutput(redactSecrets(String(value || "").trim()), maxChars);
  if (/\[REDACTED/i.test(text)) {
    throw new Error("Skill tidak boleh menyimpan credential/token.");
  }
  return text;
}

function emptyStore() {
  return { version: 1, skills: [] };
}

function normalizeSkill(input = {}, existing = null) {
  const name = normalizeName(input.name || existing?.name);
  if (!name) throw new Error("Nama skill wajib diisi.");

  const createdAt = existing?.createdAt || input.createdAt || nowIso();
  return {
    name,
    description: sanitizeText(input.description || existing?.description || "", 800),
    trigger: sanitizeText(input.trigger || existing?.trigger || name, 400),
    steps: Array.isArray(input.steps) ? input.steps.map((s) => sanitizeText(s, 500)).filter(Boolean).slice(0, 20) : (existing?.steps || []),
    safetyChecks: Array.isArray(input.safetyChecks) ? input.safetyChecks.map((s) => sanitizeText(s, 400)).filter(Boolean).slice(0, 20) : (existing?.safetyChecks || []),
    verification: Array.isArray(input.verification) ? input.verification.map((s) => sanitizeText(s, 400)).filter(Boolean).slice(0, 12) : (existing?.verification || []),
    fallback: Array.isArray(input.fallback) ? input.fallback.map((s) => sanitizeText(s, 400)).filter(Boolean).slice(0, 12) : (existing?.fallback || []),
    createdAt,
    updatedAt: nowIso()
  };
}

async function readStore() {
  try {
    const raw = await fs.readFile(skillsFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.skills)) {
      return {
        version: 1,
        skills: parsed.skills.map((skill) => normalizeSkill(skill)).sort((a, b) => a.name.localeCompare(b.name))
      };
    }
  } catch {}
  return emptyStore();
}

async function writeStore(store) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const normalized = {
    version: 1,
    skills: (store.skills || []).map((skill) => normalizeSkill(skill)).sort((a, b) => a.name.localeCompare(b.name))
  };
  await fs.writeFile(skillsFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function listSkills() {
  const store = await readStore();
  return store.skills;
}

export async function getSkill(name) {
  const key = normalizeName(name);
  if (!key) return null;
  const store = await readStore();
  return store.skills.find((skill) => skill.name === key) || null;
}

export async function deleteSkill(name) {
  const key = normalizeName(name);
  if (!key) throw new Error("Nama skill wajib diisi.");
  const store = await readStore();
  const before = store.skills.length;
  store.skills = store.skills.filter((skill) => skill.name !== key);
  await writeStore(store);
  return before - store.skills.length;
}

export async function saveSkill(input) {
  const store = await readStore();
  const key = normalizeName(input?.name);
  if (!key) throw new Error("Nama skill wajib diisi.");
  const existing = store.skills.find((skill) => skill.name === key) || null;
  const skill = normalizeSkill({ ...input, name: key }, existing);
  store.skills = [...store.skills.filter((item) => item.name !== key), skill];
  await writeStore(store);
  return skill;
}

export async function saveSkillFromLastWorkflow(name) {
  const workflow = await getLast("lastSuccessfulWorkflow");
  if (!workflow || typeof workflow !== "object") {
    throw new Error("Belum ada workflow sukses yang bisa disimpan sebagai skill.");
  }

  const files = Array.isArray(workflow.files) ? workflow.files : [];
  const tools = Array.isArray(workflow.tools) ? workflow.tools : [];
  const verification = workflow.verification ? [workflow.verification] : ["npm run check if available"];

  return saveSkill({
    name,
    description: workflow.summary || `Reusable workflow for ${name}`,
    trigger: workflow.trigger || name,
    steps: [
      "Inspect project state before editing.",
      tools.length ? `Use these tool types when relevant: ${tools.join(", ")}` : "Use read/search/list tools before mutation.",
      files.length ? `Review touched files pattern: ${files.join(", ")}` : "Keep file changes scoped.",
      "Apply changes with backup for existing files.",
      "Run verification before reporting completion."
    ],
    safetyChecks: [
      "Stay inside PROJECT_ROOT.",
      "Do not read or store secrets.",
      "Ask approval for destructive, public-impact, credential-impact, or outside-scope actions."
    ],
    verification,
    fallback: [
      "If verification fails, inspect the first actionable error.",
      "Fix once or twice, then report the exact blocker if still failing."
    ]
  });
}

export function formatSkill(skill) {
  if (!skill) return "Skill tidak ditemukan.";
  return [
    `Skill: ${skill.name}`,
    skill.description ? `Description: ${skill.description}` : null,
    `Trigger: ${skill.trigger || skill.name}`,
    "",
    "Steps:",
    ...(skill.steps || []).map((step, index) => `${index + 1}. ${step}`),
    "",
    "Safety checks:",
    ...(skill.safetyChecks || []).map((step) => `- ${step}`),
    "",
    "Verification:",
    ...(skill.verification || []).map((step) => `- ${step}`),
    "",
    "Fallback:",
    ...(skill.fallback || []).map((step) => `- ${step}`),
    "",
    `Updated: ${skill.updatedAt}`
  ].filter((line) => line !== null).join("\n");
}
