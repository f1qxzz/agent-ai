<div align="center">

# Agent AI

**Telegram AI Familiar & Coding Agent**

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Gemini](https://img.shields.io/badge/Gemini-AI-4285F4?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](#)

<br>

**Bukan chatbot biasa. Bisa inspect project, edit file, jalankan code, manage memory, dan push back kalau instruksinya berisiko.**

<br>

</div>

---

## Apa itu Agent AI?

Agent AI adalah Telegram bot yang berfungsi sebagai **coding familiar** — asisten AI yang punya identity, memory, skills, dan approval system. Dia bisa:

- Inspect dan edit project kamu langsung dari Telegram
- Simpan preference dan workflow sebagai memory & skills
- Push back kalau instruksi berisiko atautechnically bad
- Connect ke GitHub, Discord, dan X (Twitter)

Bukan remote shell proxy. Bukan credential viewer. Bukan public posting bot tanpa approval.

---

## Fitur Utama

<table>
<tr>
<td width="50%">

#### Coding Agent
- Read, write, edit file dengan backup
- Jalankan command & verify hasilnya
- Natural language routing (Bahasa Indonesia)
- Identity di `SOUL.md` + rules di `AGENT.md`
- Push back kalau instruksi berisiko

</td>
<td width="50%">

#### Memory & Skills
- Persistent memory (preferences, project facts)
- Reusable skills (workflow yang sudah berhasil)
- Session state temporary
- Tidak menyimpan credentials di memory

</td>
</tr>
</table>

---

## Connector

<table>
<tr>
<td>

#### GitHub
- Read repo, issues, PR, branches
- Create repo, push, release (butuh approval)

</td>
<td>

#### Discord
- Kirim pesan ke allowed channel
- Moderation (butuh approval)

</td>
<td>

#### X (Twitter)
- Read profile, build draft
- Post tweet, DM (butuh approval)

</td>
</tr>
</table>

---

## Quick Start

```bash
# Clone
git clone https://github.com/f1qxzz/agent-ai.git
cd agent-ai

# Install
npm install

# Konfigurasi
cp .env.example .env
# Edit .env (isi TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_ID, AI provider)

# Cek syntax
npm run check

# Jalankan
npm start
```

### BotFather Setup

1. Buka BotFather di Telegram
2. `/newbot` → copy bot token
3. Paste ke `.env` sebagai `TELEGRAM_BOT_TOKEN=`
4. Dapatkan Telegram ID kamu (gunakan `/whoami` setelah bot jalan)
5. Set `OWNER_TELEGRAM_ID=` di `.env`

---

## Konfigurasi

```env
# Identity
AGENT_NAME=O-W-O
AGENT_OWNER=@f1qxzz

# Telegram
TELEGRAM_BOT_TOKEN=
OWNER_TELEGRAM_ID=

# Project scope
PROJECT_ROOT=D:/PROJECT/my-app

# AI Provider
AI_PROVIDER=gemini
AI_MODEL=gemini-2.0-flash
GEMINI_API_KEY=

# Connectors (optional)
ENABLE_GITHUB_CONNECTOR=true
GITHUB_TOKEN=
```

> Jangan pernah paste token ke Telegram chat. Selalu edit `.env` langsung.

---

## Arsitektur

```
Telegram  ──►  Bot Core  ──►  AI Gateway  ──►  Gemini / Kiro
                  │                │
                  ▼                ▼
            Memory Store     Tool Executor
            Skills Store          │
                                  ▼
                           File / Git / Connector
```

---

## Commands

### Core

| Command | Deskripsi |
|---------|-----------|
| `/start` | Mulai bot |
| `/help` | Daftar command |
| `/status` | Status bot & koneksi |
| `/whoami` | Info Telegram ID |
| `/ask <pertanyaan>` | Tanya ke AI |

### File Management

| Command | Deskripsi |
|---------|-----------|
| `/files` | Browse project |
| `/read <path>` | Baca file |
| `/write <path> <content>` | Tulis file |
| `/edit <path> <instruksi>` | Edit file dengan AI |
| `/backup <path>` | Backup file |

### Runtime

| Command | Deskripsi |
|---------|-----------|
| `/run <command>` | Jalankan command |
| `/stop [label\|all]]` | Stop process |
| `/logs` | Lihat logs |
| `/sync` | Sync workspace |

### Memory & Skills

| Command | Deskripsi |
|---------|-----------|
| `/memory` | Lihat memory |
| `/memory add <text>` | Tambah memory |
| `/memory forget <keyword>` | Hapus memory |
| `/skills` | Lihat skills |
| `/skill save <name>` | Simpan sebagai skill |

### Approval

| Command | Deskripsi |
|---------|-----------|
| `/approvals` | Lihat ticket pending |
| `/approve <id>` | Setujui aksi |
| `/reject <id>` | Tolak aksi |

---

## Natural Language

Tidak perlu hafal command. Cukup tulis natural:

```text
cek error project ini
jelaskan struktur project
baca package.json
buatkan halaman login
edit navbar biar responsive
jalankan npm run check
push ke github
buat issue di github
ingat kalau aku suka React Tailwind
simpan workflow debugging ini sebagai skill
```

---

## Security

### Yang diblokir otomatis:
- `.env`, `*.pem`, `*.key`, `id_rsa`, credentials, tokens, cookies
- `rm -rf`, `format`, `shutdown`, `git push --force`
- PowerShell encoded commands, `curl | bash`

### Yang butuh approval:
- Create repo, push, force push, merge PR, delete repo
- Post tweet, DM, follow/unfollow
- Kirim pesan ke Discord di luar allowlist

### Semua output melewati secret redaction.

---

## Struktur Project

```
agent-ai/
├── SOUL.md                 # Identity & behavior rules
├── AGENT.md                # Coding rules
├── src/
│   ├── core/               # Bot core, config, memory, skills
│   ├── ai/                 # AI gateway, agent, tools
│   ├── commands/           # Command handler
│   ├── connectors/         # GitHub, Discord, X
│   ├── system/             # Terminal, process manager
│   └── utils/              # Security, file manager, git
├── data/                   # Memory & skills (runtime)
└── .env.example            # Template konfigurasi
```

---

## Troubleshooting

| Error | Solusi |
|-------|--------|
| `Konfigurasi belum lengkap` | Isi `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, dan minimal 1 AI provider key |
| `Connector belum aktif` | Set `ENABLE_<SERVICE>_CONNECTOR=true`, isi credential, lalu `/connector test <service>` |
| `Path sensitif diblokir` | Normal untuk `.env`, keys, credentials. Minta status, bukan raw value |
| `Action butuh approval` | Jalankan `/approvals`, review, lalu `/approve <id>` |

---

## License

MIT
