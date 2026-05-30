# O-W-O Telegram AI Familiar

O-W-O is a Telegram Familiar / Coding Agent for local projects. It is not just a
Telegram remote command bot. It has a permanent identity in `SOUL.md`, project
coding rules in `AGENT.md`, persistent memory, reusable skills, approval
boundaries, connector safety, and a natural language router for coding work.

## What Makes It Different

A normal chatbot only answers messages. O-W-O can inspect a project, edit files
with backups, run verification, keep durable preferences, reuse successful
workflows as skills, and push back when an instruction is risky or technically
bad.

O-W-O still has boundaries:

- It does not print credentials.
- It does not read `.env` into AI context.
- It does not act outside `PROJECT_ROOT` without approval.
- It does not publish, push, deploy, delete, or perform public-impact actions
  without approval.

## Setup

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm run check
npm start
```

Edit `.env` locally. Do not paste tokens into Telegram chat.

## Telegram BotFather

1. Open BotFather in Telegram.
2. Create a bot with `/newbot`.
3. Copy the bot token into `.env` as `TELEGRAM_BOT_TOKEN=`.
4. Start the bot with `npm start`.

## Owner Telegram ID

Use one of these:

- Message a trusted ID bot and copy your numeric Telegram ID.
- Temporarily run the bot, send `/whoami`, then copy `Telegram user id`.

Set it in `.env`:

```env
OWNER_TELEGRAM_ID=
TELEGRAM_USER_ID=
```

`OWNER_TELEGRAM_ID` is canonical. `TELEGRAM_USER_ID` is kept for backward
compatibility.

## AI Provider

Set the provider and model:

```env
AI_PROVIDER=
AI_MODEL=
AI_AUTO_FALLBACK=
AI_FALLBACK_ORDER=
```

Optional keys:

```env
GEMINI_API_KEY=
KIRO_API_KEY=
```

The bot loads `SOUL.md` and `AGENT.md` into internal prompts. These files define
identity, language policy, autonomy levels, approval rules, memory policy,
skills policy, and verification rules.

## Project Root

Set the project scope:

```env
PROJECT_ROOT=D:/PROJECT/my-app
```

All file tools must stay inside `PROJECT_ROOT`. Reading private files like
`.env`, keys, cookies, sessions, credentials, and tokens is blocked.

## GitHub Connector

Enable only when needed:

```env
ENABLE_GITHUB_CONNECTOR=true
GITHUB_TOKEN=
GITHUB_DEFAULT_OWNER=
GITHUB_DEFAULT_REPO=
```

Safe actions:

- get status
- test connection
- read repo
- list repos
- list issues
- list pull requests
- list branches

Approval required:

- create repo
- push
- force push
- merge pull request
- delete repo
- update secret
- create release

## Discord Connector

```env
ENABLE_DISCORD_CONNECTOR=true
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_GUILD_ID=
DISCORD_ALLOWED_CHANNEL_IDS=
```

Safe actions:

- get identity
- list allowed channels

Autonomous + Log:

- send message to an allowlisted channel only when explicitly requested

Approval required:

- send outside allowlist
- mention everyone
- delete message
- moderation actions

## X Connector

```env
ENABLE_X_CONNECTOR=true
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=
X_BEARER_TOKEN=
```

Safe actions:

- get identity
- read profile/status
- build draft

Approval required:

- post tweet
- public reply
- DM
- follow/unfollow
- delete tweet
- update profile

## Approval System

Risky actions create an approval ticket instead of running immediately.

Ticket fields:

- `id`
- `action`
- `risk`
- `target`
- `reason`
- `preview`
- masked `command` or payload
- `expiresAt`
- `createdBy`
- `status`

Commands:

```text
/approvals
/approve <id>
/reject <id>
```

Approved actions run through the same executor path, not a bypass.

## Memory System

Memory is stored in `data/memory.json`.

Persistent categories:

- `preferences`
- `environment`
- `projectFacts`
- `corrections`
- `workflows`

Temporary runtime category:

- `sessionState`

Memory must not store task logs, copied chat history, raw command output,
credentials, tokens, private keys, cookies, or session data.

Commands:

```text
/memory
/memory add <text>
/memory forget <keyword>
```

Natural examples:

```text
ingat kalau aku suka React Tailwind
lupakan memory tentang React Tailwind
apa yang kamu ingat
```

## Skills System

Skills are reusable procedural workflows stored in `data/skills.json`. A skill
is not a chat log.

Skill shape:

```json
{
  "name": "",
  "description": "",
  "trigger": "",
  "steps": [],
  "safetyChecks": [],
  "verification": [],
  "fallback": [],
  "createdAt": "",
  "updatedAt": ""
}
```

Commands:

```text
/skills
/skills show <name>
/skills delete <name>
/skill save <name>
```

After a complex workflow succeeds, O-W-O may offer to save it as a skill. It
does not auto-save without approval.

## Natural Language Examples

```text
cek error project ini
jelaskan struktur project
baca package.json
buatkan halaman login
edit navbar biar responsive
jalankan npm run check
push ke github
buat issue di github
buat draft tweet
kirim pesan ke discord channel allowed
ingat kalau aku suka React Tailwind
simpan workflow debugging ini sebagai skill
```

Risky actions from natural language still require approval.

## Command List

Core:

```text
/start
/help
/status
/whoami
/agent
/ask
```

Files:

```text
/files
/read <path>
/write <path> <content>
/edit <path> <instruction>
/backup <path>
```

Runtime:

```text
/run <command>
/stop [label|all]
/logs
/sync
```

Approval:

```text
/approvals
/approve <id>
/reject <id>
```

Memory:

```text
/memory
/memory add <text>
/memory forget <keyword>
```

Skills:

```text
/skills
/skills show <name>
/skills delete <name>
/skill save <name>
```

Connectors:

```text
/connector
/connector status <github|discord|x>
/connector test <github|discord|x>
/connector refresh <github|discord|x>
/login github
```

Some older convenience commands still exist for laptop remote control and local
dev server management. `/help` shows the live command surface.

## Security Boundaries

Blocked from user-facing reads:

- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `id_rsa`
- `credentials`
- `token`
- `cookie`
- `session`

Blocked or approval-gated commands:

- `rm -rf`
- `del /s`
- `format`
- `diskpart`
- `reg delete`
- `shutdown`
- `reboot`
- `git reset --hard`
- `git clean`
- `git push --force`
- `curl | bash`
- `wget | bash`
- PowerShell encoded commands
- `npm publish`

All Telegram output must pass secret redaction.

## Verification

Run:

```bash
npm run check
```

If the active project has these scripts, run them when relevant:

```bash
npm test
npm run build
npm run lint
```

O-W-O should not report coding work as finished before verification has a
concrete result.

## Troubleshooting

`Konfigurasi belum lengkap`

- Fill `TELEGRAM_BOT_TOKEN`.
- Fill `OWNER_TELEGRAM_ID` or `TELEGRAM_USER_ID`.
- Fill at least one configured AI provider key or configure a local provider.

`Connector belum aktif`

- Set `ENABLE_<SERVICE>_CONNECTOR=true`.
- Fill the service credential in `.env`.
- Run `/connector test <service>`.

`Path sensitif diblokir`

- This is expected for `.env`, keys, credentials, cookies, and session files.
- Ask for key status, not raw values.

`Action butuh approval`

- Run `/approvals`.
- Review the masked preview.
- Run `/approve <id>` or `/reject <id>`.

## Future Extensions

These are not implemented as guaranteed behavior unless code exists for them:

- autonomous browser login outside the existing GitHub device flow
- wallet/on-chain actions
- email connector
- multi-user rooms
