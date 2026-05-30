# O-W-O Agent Sync Notes

This file tracks manual follow-up ideas for aligning the Telegram bot with the
O-W-O Familiar model. It is not a runtime prompt.

Runtime source of truth:

- `SOUL.md`
- `AGENT.md`
- `src/ai/ai.js`
- `src/ai/agent.js`
- `src/commands/commands.js`
- `src/core/memory.js`
- `src/core/skills.js`
- `src/connectors/approvalPolicy.js`
- `src/connectors/connectorManager.js`

Rules:

- Keep O-W-O identity consistent.
- Keep Telegram chat in Indonesian aku/kamu.
- Keep secrets out of prompts, memory, logs, and docs.
- Keep destructive/public/credential/outside-scope actions behind approval.
- Keep memory persistent categories separate from temporary session state.
- Keep skills procedural, not chat logs.
