import { chat, extractJson, readAgentInstructions, AGENTS } from "./ai.js";
import { readProjectFile, getProjectContext } from "../utils/fileManager.js";
import { assertNoSecretsForAi, getDestructiveCommandReason, redactSecrets, truncateOutput } from "../utils/security.js";
import { toolSpecsForPrompt, executeTool } from "./tools.js";
import { config } from "../core/config.js";

// ─────────────────────────────────────────────
// Legacy "plan + generate" flow (backward compat)
// ─────────────────────────────────────────────

async function chatRaw(systemInstruction, userContent, { json = false } = {}) {
  const content = await chat(
    [
      { role: "system", content: systemInstruction },
      { role: "user", content: userContent }
    ],
    {
      // Use the tools agent for raw JSON so structured output stays parseable.
      agent: json ? AGENTS.TOOLS : AGENTS.CODE_CHAT,
      json,
      maxJsonRetries: 2
    }
  );
  if (!content) throw new Error("Respons AI kosong.");
  return redactSecrets(content);
}

export async function planAutonomousAction({ projectDir, userRequest, projectContext }) {
  const agentInstructions = await readAgentInstructions(projectDir).catch(() => "");
  const agentName = config.agentName || "O-W-O";
  const systemPrompt = [
    `Kamu adalah ${agentName}, Telegram Familiar / Coding Agent yang merencanakan perubahan code.`,
    "Kamu wajib mengikuti SOUL.md dan AGENT.md.",
    "Tugasmu menganalisis request user dan membuat rencana aksi detail.",
    "",
    "RULES:",
    "1. Analisis konteks project (framework, struktur, file yang ada) dulu.",
    "2. Tentukan file mana saja yang perlu dibuat atau diedit.",
    "3. Untuk setiap file, jelaskan apa yang harus dilakukan.",
    "4. Maksimal 6 file per action plan.",
    "5. Gunakan Bahasa Indonesia dengan register aku/kamu, no emoji, no hype, technical terms tetap English.",
    "6. Ikuti conventions framework (React, Next.js, Vue, dll).",
    "7. Jangan rencanakan aksi destructive/public/credential/outside-scope tanpa approval.",
    "8. Memory persistent hanya untuk fakta stabil; skills hanya procedural workflow reusable.",
    "9. Setelah edit, verification wajib: npm run check kalau ada, lalu build/lint/test yang relevan.",
    "",
    agentInstructions ? `=== PROJECT INSTRUCTIONS (SOUL.md / AGENT.md) ===\n${agentInstructions}\n` : "",
    "Balas HANYA dengan JSON valid, format:",
    '{',
    '  "summary": "Ringkasan singkat",',
    '  "steps": [',
    '    {',
    '      "action": "create" | "edit",',
    '      "filePath": "path/to/file.ext",',
    '      "description": "Apa yang dilakukan di file ini",',
    '      "priority": 1',
    '    }',
    '  ],',
    '  "estimatedImpact": "Dampak ke user"',
    '}'
  ].filter(Boolean).join("\n");

  const userContent = [
    "Konteks project:",
    projectContext,
    "",
    "Request user:",
    userRequest
  ].join("\n");

  const response = await chatRaw(systemPrompt, userContent, { json: true });
  const plan = extractJson(response);

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("AI gagal membuat rencana aksi yang valid.");
  }
  plan.steps.sort((a, b) => (a.priority || 99) - (b.priority || 99));
  if (plan.steps.length > 6) plan.steps = plan.steps.slice(0, 6);
  return plan;
}

export async function generateFileContent({
  projectDir,
  projectContext,
  userRequest,
  step,
  existingContent,
  completedFiles
}) {
  const agentInstructions = await readAgentInstructions(projectDir).catch(() => "");
  const agentName = config.agentName || "O-W-O";
  const isCreate = step.action === "create";
  const completedContext = completedFiles.length > 0
    ? [
        "",
        "File yang sudah selesai digenerate (untuk referensi import):",
        ...completedFiles.map((f) => `--- ${f.filePath} ---\n${truncateOutput(f.content, 4000)}`)
      ].join("\n")
    : "";

  const systemPrompt = [
    `Kamu adalah ${agentName}, Telegram Familiar / Coding Agent yang menggenerate isi file.`,
    "Kamu wajib mengikuti SOUL.md dan AGENT.md.",
    "Jawab HANYA dengan JSON valid.",
    "Field content WAJIB berisi isi file LENGKAP, bukan diff.",
    "Code yang dihasilkan:",
    "1. Mengikuti conventions project.",
    "2. Import/export benar.",
    "3. Tanpa placeholder/TODO.",
    "4. Production-ready.",
    "5. Tidak mengandung credential/token/key hardcoded.",
    "6. Comments dan code tetap English.",
    "",
    agentInstructions ? `=== PROJECT INSTRUCTIONS (SOUL.md / AGENT.md) ===\n${agentInstructions}\n` : "",
    'Format: {"summary": "ringkasan", "content": "isi file lengkap"}'
  ].filter(Boolean).join("\n");

  const userContent = [
    "Konteks project:",
    projectContext,
    completedContext,
    "",
    isCreate ? `Buat file baru: ${step.filePath}` : `Edit file: ${step.filePath}`,
    "",
    isCreate ? "" : `Isi saat ini:\n\`\`\`\n${existingContent}\n\`\`\``,
    "",
    `Deskripsi: ${step.description}`,
    "",
    `Request user: ${userRequest}`
  ].join("\n");

  const response = await chatRaw(systemPrompt, userContent, { json: true });
  const result = extractJson(response);

  if (!result || typeof result.content !== "string") {
    throw new Error(`AI gagal generate content untuk ${step.filePath}`);
  }
  assertNoSecretsForAi(result.content);
  return {
    summary: redactSecrets(result.summary || step.description),
    content: result.content
  };
}

export function isAutonomousRequest(text) {
  const lowered = String(text || "").toLowerCase().trim();
  const actionPatterns = [
    /\b(tambahkan|tambahin|buat(?:kan)?|bikin(?:in)?|kasih|pasang(?:kan)?|implementasi(?:kan)?|terapkan)\b.*\b(fitur|feature|animasi|animation|efek|effect|komponen|component|halaman|page|section|widget|button|tombol|navbar|sidebar|footer|header|modal|popup|form|card|slider|carousel|loading|skeleton|dark\s*mode|light\s*mode|theme|responsive|hover|transition|gradient|shadow|glow|particle|parallax|scroll|toast|notification|alert|badge|avatar|icon|menu|dropdown|tab|accordion|tooltip|progress|spinner|chart|graph|table|grid|layout|style|css|desain|design|kode|coding|codingan|script)/i,
    /\b(mau|pengen|ingin|tolong)\b.*\b(tambahin|buatin|bikinkan|kasih|pasang|buat|bikin)\b/i,
    /\b(tambah|buat|bikin|kasih|pasang)\b\s+(animasi|fitur|efek|komponen|halaman|tombol|loading|dark\s*mode)/i,
    /\b(bisa|boleh|coba)\b.*\b(tambahin|buatin|bikin(?:in)?|kasih|pasang(?:kan)?)\b/i,
    /\b(upgrade|improve|enhance|perbaiki|rapikan|perbarui|modernkan|modernisasi)\b.*\b(ui|ux|tampilan|interface|design|desain|styling|css|halaman|page)/i,
    /\b(refactor|migrasi|migrate|convert|ubah)\b.*\b(jadi|to|menjadi|ke)\b/i,
    /\b(baca|read|lihat)\b.*\b(lalu|terus|kemudian|setelah itu|dan)\b.*\b(eksekusi|terapkan|implementasi(?:kan)?|sync|sinkronkan|perbaiki|ubah|edit|poles|rapikan|jalankan)\b/i,
    /\b(eksekusi|terapkan|implementasi(?:kan)?|sync|sinkronkan|perbaiki|rapikan|poles)\b.*\b(project|repo|kode|code|coding|fitur|logic|flow|rules|prompt|config|security|agent|bot|src\/|\.js|\.md)\b/i,
  ];
  return actionPatterns.some((pattern) => pattern.test(lowered));
}

export function extractActionRequest(text) {
  return String(text || "").trim();
}

export async function safeReadFile(projectDir, filePath) {
  try {
    const file = await readProjectFile(projectDir, filePath, { forAi: true });
    return file.content;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// New: Tool-calling agent loop (Cursor / Claude Code style)
//
// AI is given the user request + tool list, and is expected to emit a JSON
// object {tool: "name", args: {...}} per turn. We execute the tool, feed
// the result back as a "tool_result" message, and loop until AI calls
// "finish" or we exceed MAX_STEPS.
// ─────────────────────────────────────────────

const MAX_AGENT_STEPS = 18;

function buildToolAgentSystemPrompt(agentInstructions = "") {
  const agentName = config.agentName || "O-W-O";
  return [
    `Kamu adalah ${agentName}, Telegram Familiar / Coding Agent autonomous yang membantu user via Telegram.`,
    "Kamu punya identity stabil, memory policy, skills policy, approval boundary, dan connector boundary.",
    "Kamu bukan chatbot generic dan bukan remote shell proxy.",
    "Kamu PUNYA AKSES ke project user via tool calls. Pakai tool untuk eksplor, baca, edit, dan jalankan command aman.",
    "Kamu wajib mengikuti SOUL.md dan AGENT.md kalau tersedia di project instructions.",
    "Language policy untuk final/user-facing summary: Bahasa Indonesia, aku/kamu, no emoji, no hype, technical terms tetap English.",
    "",
    "STRATEGI:",
    "1. Saat menerima request, mulai dengan list_dir / search / read_file untuk memahami konteks.",
    "2. Jangan menebak struktur project — verifikasi dengan tool dulu.",
    "3. Saat melakukan edit, pakai apply_diff untuk perubahan kecil & write_file untuk file baru atau rewrite besar.",
    "4. Setelah selesai edit, jalankan run_command untuk verify. Utamakan npm run check kalau tersedia, lalu build/lint/test yang relevan.",
    "5. Kalau build gagal, baca error, fix, dan retry. Maksimal 3x retry per file.",
    "6. Akhiri SELALU dengan tool 'finish' beserta summary singkat.",
    "7. Untuk aksi coding reversible yang jelas diminta, langsung jalan dengan tools dan pastikan backup.",
    "8. Jika task berpotensi destructive/irreversible/public-impact/credential-impact/outside-scope, jangan jalankan. Pakai finish dan jelaskan approval yang dibutuhkan.",
    "9. Jangan baca .env, credential, token, cookie, private key, atau session file.",
    "10. Jangan simpan task progress atau command output sebagai persistent memory.",
    "11. Setelah workflow kompleks sukses, boleh tawarkan penyimpanan skill, tapi jangan auto-save.",
    "",
    "OUTPUT FORMAT:",
    "Setiap turn, balas HANYA satu JSON object valid dengan field wajib 'tool' dan 'args'.",
    "Boleh tambah field 'thought' (string singkat) untuk reasoning.",
    "Karakter pertama HARUS '{' dan karakter terakhir HARUS '}'.",
    "Jangan markdown fence, jangan komentar JSON, jangan trailing comma, jangan teks lain.",
    "",
    "Contoh:",
    '{"thought": "Aku perlu lihat struktur src/ dulu", "tool": "list_dir", "args": {"path": "src"}}',
    '{"thought": "Sekarang aku tahu Navbar ada di src/components/Navbar.jsx", "tool": "read_file", "args": {"path": "src/components/Navbar.jsx"}}',
    '{"thought": "Tambah dark mode toggle dengan useState", "tool": "apply_diff", "args": {"path": "src/components/Navbar.jsx", "search": "function Navbar() {", "replace": "function Navbar() {\\n  const [dark, setDark] = useState(false);"}}',
    '{"thought": "Selesai", "tool": "finish", "args": {"summary": "Dark mode toggle ditambahkan di Navbar"}}',
    "",
    "TOOLS YANG TERSEDIA:",
    toolSpecsForPrompt(),
    "",
    agentInstructions ? `=== PROJECT INSTRUCTIONS (SOUL.md / AGENT.md / legacy rules) ===\n${agentInstructions}` : ""
  ].filter(Boolean).join("\n");
}

function getToolApprovalReason(toolName, args = {}) {
  if (toolName === "run_command") {
    return getDestructiveCommandReason(args.command);
  }
  return "";
}

/**
 * Run autonomous tool-calling agent.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Active project directory.
 * @param {string} opts.userRequest - User's natural language request.
 * @param {string|number} opts.userId - Telegram user id, used for rate limit / log scoping.
 * @param {function} [opts.onStep] - Optional callback (step, total) called before each iteration. Useful for live progress.
 * @param {AbortSignal} [opts.signal] - Optional abort signal to cancel the agent mid-run.
 * @returns {Promise<{summary: string, steps: Array, files: string[], success: boolean, aborted: boolean}>}
 */
export async function runToolCallingAgent({ projectDir, userRequest, userId, onStep, signal }) {
  const agentInstructions = await readAgentInstructions(projectDir).catch(() => "");
  const projectOverview = await getProjectContext(projectDir).catch(() => "(failed to load project overview)");

  const systemPrompt = buildToolAgentSystemPrompt(agentInstructions);
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        "Project overview:",
        projectOverview,
        "",
        "Request user:",
        userRequest,
        "",
        "Mulai dengan tool call pertama."
      ].join("\n")
    }
  ];

  const stepLog = [];
  const filesTouched = new Set();
  let finalSummary = "";
  let success = false;
  let aborted = false;
  let totalPromptChars = 0;
  let totalResponseChars = 0;

  // Loop detector: kalau AI manggil tool yang sama dengan args yang sama 3x berturut-turut, force stop.
  const recentSignatures = [];
  const SIGNATURE_WINDOW = 3;

  // Consecutive parse failures — kalau 3x berturut-turut AI ga balas JSON valid,
  // baru kita angkat tangan. Sebelumnya kita kasih corrective prompt + retry.
  let consecutiveParseFails = 0;
  const MAX_PARSE_FAILS = 3;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (signal?.aborted) {
      aborted = true;
      finalSummary = "Agent dibatalkan oleh user.";
      stepLog.push({ kind: "aborted" });
      break;
    }
    if (onStep) {
      try { await onStep({ step, max: MAX_AGENT_STEPS, log: stepLog }); } catch {}
    }

    let response;
    try {
      const promptSize = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
      totalPromptChars += promptSize;
      // Use the raw tools agent (no persona) so JSON parsing stays recoverable.
      // dan SENGAJA ga set json:true di sini — validasi JSON dilakukan
      // manual di loop ini supaya parse error bisa di-recover dengan
      // corrective prompt, bukan langsung throw dari chat().
      response = await chat(messages, { agent: AGENTS.TOOLS });
      totalResponseChars += (response?.length || 0);
    } catch (err) {
      stepLog.push({ kind: "ai_error", error: err.message });
      finalSummary = `AI error: ${err.message}`;
      break;
    }

    let parsed;
    try {
      parsed = extractJson(response);
      consecutiveParseFails = 0; // reset on success
    } catch (err) {
      consecutiveParseFails++;
      stepLog.push({
        kind: "parse_error",
        error: err.message,
        attempts: consecutiveParseFails,
        raw: truncateOutput(response, 400)
      });

      if (consecutiveParseFails >= MAX_PARSE_FAILS) {
        finalSummary = `AI gagal mengembalikan JSON valid setelah ${MAX_PARSE_FAILS} percobaan. Coba ulangi request atau ganti model di /engine.`;
        break;
      }

      messages.push({ role: "assistant", content: response });
      messages.push({
        role: "user",
        content: [
          "Output sebelumnya bukan JSON valid.",
          "Balas ULANG dengan SATU JSON object saja, format wajib:",
          '{"thought":"...","tool":"<tool_name>","args":{...}}',
          "ATURAN KETAT:",
          "- Karakter pertama HARUS '{' dan terakhir HARUS '}'.",
          "- TIDAK boleh ada teks/markdown/fence di luar JSON.",
          "- TIDAK boleh ada komentar JSON atau trailing comma.",
          "- TIDAK boleh ada sapaan, preamble, atau penjelasan.",
          "- Kalau ragu, pakai tool 'list_dir' dengan args {\"path\":\".\"}."
        ].join("\n")
      });
      continue;
    }

    const toolName = parsed.tool || parsed.name;
    const args = parsed.args || parsed.arguments || {};
    const thought = parsed.thought || "";

    if (!toolName) {
      stepLog.push({ kind: "no_tool", thought });
      messages.push({ role: "assistant", content: JSON.stringify(parsed) });
      messages.push({
        role: "user",
        content: "Tidak ada field 'tool'. Balas ulang dengan {tool: '...', args: {...}}."
      });
      continue;
    }

    if (toolName === "finish") {
      finalSummary = args.summary || "Selesai.";
      success = true;
      stepLog.push({ kind: "finish", summary: finalSummary, thought });
      break;
    }

    // Loop detection
    const signature = `${toolName}:${JSON.stringify(args || {})}`.slice(0, 500);
    recentSignatures.push(signature);
    if (recentSignatures.length > SIGNATURE_WINDOW) recentSignatures.shift();
    if (
      recentSignatures.length === SIGNATURE_WINDOW &&
      recentSignatures.every((s) => s === recentSignatures[0])
    ) {
      stepLog.push({ kind: "loop_detected", tool: toolName });
      finalSummary = `Agent terjebak loop pada tool '${toolName}'. Stop otomatis.`;
      // Inform AI and let it conclude
      messages.push({ role: "assistant", content: JSON.stringify(parsed) });
      messages.push({
        role: "user",
        content: "Kamu memanggil tool yang sama berulang kali. Sudahi dengan tool 'finish' dan jelaskan progress yang sudah dicapai."
      });
      // Reset signatures so next finish call gets through
      recentSignatures.length = 0;
      continue;
    }

    if (onStep) {
      try { await onStep({ step, max: MAX_AGENT_STEPS, log: stepLog, current: { tool: toolName, args, thought } }); } catch {}
    }

    const approvalReason = getToolApprovalReason(toolName, args);
    if (approvalReason) {
      finalSummary = `Butuh approval sebelum menjalankan ${toolName}: ${approvalReason} Tidak ada aksi destructive yang dijalankan.`;
      stepLog.push({ kind: "approval_required", tool: toolName, args, thought, reason: approvalReason });
      break;
    }

    const result = await executeTool({ name: toolName, args, projectDir, userId });
    if (toolName === "write_file" || toolName === "apply_diff") {
      if (result.meta?.relativePath) filesTouched.add(result.meta.relativePath);
    }

    stepLog.push({
      kind: "tool",
      tool: toolName,
      args,
      thought,
      ok: result.ok,
      output: truncateOutput(result.output || "", 1200)
    });

    messages.push({ role: "assistant", content: JSON.stringify(parsed) });
    messages.push({
      role: "user",
      content: `[tool_result name=${toolName} ok=${result.ok}]\n${result.output || "(no output)"}`
    });
  }

  if (!success && !finalSummary) {
    finalSummary = `Agent berhenti setelah ${MAX_AGENT_STEPS} step tanpa memanggil 'finish'.`;
  }

  return {
    summary: finalSummary,
    steps: stepLog,
    files: [...filesTouched],
    success,
    aborted,
    usage: {
      promptChars: totalPromptChars,
      responseChars: totalResponseChars,
      // Rough estimate: ~4 chars per token
      estimatedTokens: Math.round((totalPromptChars + totalResponseChars) / 4)
    }
  };
}
