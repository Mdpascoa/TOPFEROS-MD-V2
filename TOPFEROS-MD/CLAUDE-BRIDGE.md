# 🤖 Claude + MCP Bridge — TOPFEROS MD V2.0.0

This adds Claude to TOPFEROS MD without replacing Baileys. The design follows
[manveer/whatsapp-assistant](https://github.com/manveer/whatsapp-assistant)
(MIT). There are two independent pieces, and you can turn on either one or both.

| Piece | What it does | Files |
|---|---|---|
| **1. Claude as the AI provider** | `.ai`, AI Chat, auto-react and image analysis run on Claude instead of Gemini. Claude can also use remote MCP servers (for example an Arcade gateway for Gmail, Calendar or Slack) and web search. | `services/claudeAI.js`, `services/ai.js` |
| **2. Claude Code channel** | Claude Code reads and answers WhatsApp messages through the bot's own Baileys session, with the same tools and relay API as the original project. | `services/claudeBridge.js`, `mcp/whatsapp-channel.mjs`, `.mcp.json` |

Install dependencies first: `npm install`.

---

## 1. Claude as the AI provider

```env
AI_PROVIDER=claude            # gemini | claude. If unset: Gemini when GEMINI_API_KEY is set, otherwise Claude
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-opus-5-5  # optional (this is the default)
CLAUDE_EFFORT=                # optional: low | medium | high | xhigh | max
CLAUDE_MAX_TOKENS=16000       # optional
CLAUDE_WEB_SEARCH=false       # true = let Claude search the web (billed per search)
CLAUDE_FALLBACKS=             # "off" turns off automatic fallback when a model declines

# Optional: remote MCP servers Claude may call (Anthropic MCP connector)
CLAUDE_MCP_SERVERS=[{"name":"arcade","url":"https://<your-mcp-gateway>/mcp","authorization_token":"<token>"}]
```

Check it with `node test-ai.js`.

Notes:
- Every place that already calls `askAI` / `askAIWithImage` follows `AI_PROVIDER`, so you don't have to change any command.
- Server-side fallback is on by default: if the model declines a request, the API retries it on a fallback model.
- MCP tools run with whatever access you give the MCP server's token. Give it only the scopes you need.

---

## 2. Claude Code channel (WhatsApp → Claude Code)

```
WhatsApp ⇄ Baileys (TOPFEROS bot) ⇄ /claude-bridge (panel server) ⇄ mcp/whatsapp-channel.mjs ⇄ Claude Code
```

### Bot side

```env
CLAUDE_BRIDGE_SECRET=<long random string>   # without it the bridge is off (routes return 404)
CLAUDE_BRIDGE_ALLOWED=50911112222,50933334444  # who may talk to Claude. Default: OWNER_NUMBER. "*" = every private chat
CLAUDE_BRIDGE_SELF_CHAT=true                # send your own "Message yourself" chat to Claude
CLAUDE_BRIDGE_GROUPS=false                  # true = also forward groups
```

The bridge is mounted on the panel server at `/claude-bridge` and needs the
`x-relay-secret` header:

| Route | Body | Baileys action |
|---|---|---|
| `GET /poll?since=N&boot=ID` | — | inbound messages after cursor `N` |
| `POST /send` | `to, text, reply_to?, session?` | `sendMessage({ text })` (quoted when `reply_to` is set) |
| `POST /react` | `wamid, emoji, to?, session?` | `sendMessage({ react })` |
| `POST /mark-read` | `wamid` | `readMessages([key])` |
| `POST /send-media` | `to, type, url, caption?, filename?, reply_to?, session?` | image / video / audio / document from a URL |

What gets forwarded:
- Messages from numbers in `CLAUDE_BRIDGE_ALLOWED`, plus your own "Message yourself" chat.
- Bot commands (anything starting with `BOT_PREFIX`) stay with TOPFEROS. Claude never sees them.
- Messages the bridge sends itself are never forwarded back, so replies can't loop.
- The queue lives in memory: the last 500 messages, cleared when the bot restarts.

### Claude Code side

1. Copy `CLAUDE_BRIDGE_SECRET` into the environment Claude Code runs in, or into `TOPFEROS-MD/.env`. The channel reads that file too.
2. If the bot doesn't run on `localhost:${PANEL_PORT|PORT|3000}`, set
   `CLAUDE_BRIDGE_URL=https://<your-render-app>/claude-bridge`.
3. Start Claude Code from `TOPFEROS-MD/`. `.mcp.json` registers the `whatsapp` server.
   Turn on Claude Code channels for that server. Channels are a research preview,
   so check the Claude Code channels docs for the exact flag in your version.
4. Send a message from an allowed number. It reaches Claude Code as
   `<channel source="whatsapp" chat_id="..." wamid="..." session="...">`, and Claude
   answers with the `reply`, `react`, `mark_read` and `send_media` tools.

Workflows (skills) such as the original project's `meeting-prep` are Markdown
files that Claude Code loads from `.claude/skills/<name>/SKILL.md`. Integrations
like Gmail, Calendar or Slack come from MCP servers (for example Arcade) that you
add to Claude Code.

### Security

- Use a long random `CLAUDE_BRIDGE_SECRET`, and serve the panel over HTTPS if the bridge is reachable from the internet.
- Keep `CLAUDE_BRIDGE_ALLOWED` short. Anyone on that list can instruct the Claude Code session.
- Claude Code's own permission prompts still apply to every tool it runs.
