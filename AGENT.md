# AGENT.md - Project Coding Rules

AGENT.md defines coding rules for this repository. SOUL.md defines permanent
agent behavior. Runtime prompts must load both files before planning, editing,
or using tools.

## Runtime Stack

- Node.js ESM only. Use `import` / `export`; do not introduce CommonJS.
- Entry point: `src/core/bot.js`.
- Telegram runtime uses polling. Do not switch to webhook unless the owner
  explicitly asks.
- Keep startup side effects inside the direct-run guard in `src/core/bot.js` so
  tests and imports do not accidentally start polling.

## Source Responsibilities

- `src/core/bot.js`: bootstrap, Telegram guard wrapping, polling recovery,
  shutdown handling.
- `src/commands/commands.js`: slash command routing, natural language routing,
  Telegram UI messages, approval command flow.
- `src/ai/ai.js`: AI provider gateway, system prompt construction, SOUL/AGENT
  loading, intent classifier.
- `src/ai/agent.js`: autonomous tool-calling coding agent.
- `src/ai/tools.js`: safe project tools exposed to the agent.
- `src/core/memory.js`: persistent memory plus temporary session state.
- `src/core/skills.js`: reusable procedural skills.
- `src/connectors/*`: external connector boundaries.
- `src/system/terminal.js`: command execution and tracked dev server lifecycle.
- `src/utils/security.js`: path containment, secret redaction, command risk
  classification.
- `src/utils/fileManager.js`: safe file operations, backups, previews.

## Tool-Calling Rules

- Explore first with `list_dir`, `search`, `read_file`, `git_status`, or
  `git_diff`.
- Do not guess file structure.
- Use small targeted edits when possible.
- For existing files, create a backup before writing.
- Do not edit generated folders: `node_modules`, `dist`, `build`, `.next`,
  `coverage`, `.turbo`, `.cache`.
- Never edit `node_modules`.
- Never include secrets in prompts, diffs, logs, or Telegram output.

## Path Safety

- All project file operations must stay inside `PROJECT_ROOT`.
- Block path traversal and cross-drive escapes.
- Block user-facing reads of private files:
  - `.env`
  - `.env.*`
  - `*.pem`
  - `*.key`
  - `id_rsa`
  - `credentials`
  - `token`
  - `cookie`
  - `session`
- Do not read `.env` into AI context. Only report whether a key is set or empty.

## Terminal Safety

- Safe commands can run through the safe executor:
  - `git status`
  - `git diff`
  - `npm run check`
  - `npm test` if available
  - `npm run build` / `npm run lint` when relevant
  - tracked dev server start/stop
- Commands requiring approval:
  - package install
  - delete file/folder
  - large overwrite
  - `git push`
  - `git push --force`
  - `git reset --hard`
  - `git clean`
  - deploy
  - `npm publish`
  - public connector actions
  - credential reads
  - outside-project actions
- Block or approval-gate dangerous commands including `rm -rf`, `del /s`,
  `format`, `diskpart`, `reg delete`, `shutdown`, `reboot`, `curl | bash`,
  `wget | bash`, and PowerShell encoded commands.

## Connector Safety

- Each connector must expose `getStatus()`, `testConnection()`, and `envHelp()`.
- Read/list/status actions can be autonomous.
- Public, destructive, or account-mutating actions must go through approval.
- Discord sends are allowed without approval only to configured allowlisted
  channels and only when explicitly requested.
- X posts, replies, DMs, follows, profile updates, and deletes must require
  approval.
- GitHub push, force push, merge PR, delete repo, update secret, create release,
  and risky repo creation must require approval.

## Telegram Output Rules

- All Telegram text output must pass through `redactSecrets()`.
- Do not show raw `.env` content.
- Do not ask the user to paste tokens into chat.
- For config help, tell the user which `.env` key is missing, not the secret
  value.

## Memory Rules

- Persistent memory may store preferences, environment facts, project facts,
  repeated corrections, and stable workflows.
- Temporary task progress, logs, raw command output, copied chat history, tokens,
  cookies, and private keys must not enter persistent memory.
- All memory input must pass `sanitizeMemoryInput()` and secret redaction.

## Skills Rules

- Skills are procedural reusable workflows, not conversation logs.
- Do not auto-save skills. Offer to save after a complex workflow succeeds.
- A skill must include steps, safety checks, verification, fallback, and
  timestamps.

## Verification Rules

- After code edits, run `npm run check` when available.
- Then run `npm test`, `npm run build`, and `npm run lint` if available and
  relevant.
- Do not claim completion before verification has a concrete result.
- If verification fails, fix once or twice. If still failing, report the exact
  blocker.

## Documentation Rules

- Keep docs aligned with implemented behavior.
- Mark future extensions explicitly.
- Do not document fake features as implemented.
- Keep technical docs in English.

## Secret Rules

- No hardcoded secrets.
- No credential values in docs.
- No `.env` reads into AI context.
- No token previews beyond masked values.
