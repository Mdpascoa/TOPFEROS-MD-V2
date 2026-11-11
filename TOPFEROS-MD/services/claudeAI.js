"use strict";

// 🦁 TOPFEROS MD V2.0.0
// CLAUDE AI SERVICE (Anthropic Messages API + optional MCP servers)
//
// Konfigirasyon (Environment):
//   ANTHROPIC_API_KEY      Kle API Anthropic (obligatwa)
//   CLAUDE_MODEL           Modèl la (default: claude-opus-5-5)
//   CLAUDE_EFFORT          low | medium | high | xhigh | max (opsyonèl)
//   CLAUDE_MAX_TOKENS      Limit token pou repons lan (default: 16000)
//   CLAUDE_WEB_SEARCH      "true" pou aktive rechèch sou entènèt (default: false)
//   CLAUDE_FALLBACKS       "off" pou dezaktive fallback otomatik lè yon modèl refize
//   CLAUDE_MCP_SERVERS     JSON: [{"name":"arcade","url":"https://.../mcp","authorization_token":"..."}]
//                          Claude ap ka itilize zouti MCP sa yo (Gmail, Calendar, Slack...).

const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_MAX_TOKENS = 16000;
const MAX_PAUSE_CONTINUATIONS = 4;
const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

let client = null;

function getApiKey() {
  return String(
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    ""
  ).trim();
}

function isClaudeConfigured() {
  return Boolean(
    getApiKey() ||
    String(process.env.ANTHROPIC_AUTH_TOKEN || "").trim()
  );
}

function getModel() {
  return String(process.env.CLAUDE_MODEL || DEFAULT_MODEL).trim();
}

function getClient() {
  if (!client) {
    const Anthropic = require("@anthropic-ai/sdk");
    const apiKey = getApiKey();
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  return client;
}

function getMaxTokens(requested) {
  const fromEnv = Number(process.env.CLAUDE_MAX_TOKENS);
  const base = Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_MAX_TOKENS;

  // Thinking token yo konte nan max_tokens: pa janm desann anba baz la,
  // sinon repons yo ka koupe nan mitan.
  const asked = Number(requested);
  return Math.floor(
    Number.isFinite(asked) && asked > base ? asked : base
  );
}

function getMcpServers() {
  const raw = String(process.env.CLAUDE_MCP_SERVERS || "").trim();
  if (!raw) return [];

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error("[CLAUDE] CLAUDE_MCP_SERVERS se pa yon JSON valab:", error.message);
    return [];
  }

  if (!Array.isArray(parsed)) parsed = [parsed];

  return parsed
    .filter(item => item && typeof item.url === "string" && typeof item.name === "string")
    .map(item => ({
      type: "url",
      name: item.name.trim(),
      url: item.url.trim(),
      ...(item.authorization_token
        ? { authorization_token: String(item.authorization_token) }
        : {})
    }));
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      ["user", "assistant", "model"].includes(item.role) &&
      typeof item.content === "string" &&
      item.content.trim()
    )
    .map(item => ({
      role: item.role === "user" ? "user" : "assistant",
      content: item.content.trim()
    }));
}

function buildRequest(messages, options) {
  const mcpServers = getMcpServers();
  const tools = [];
  const betas = [];

  if (String(process.env.CLAUDE_WEB_SEARCH || "").toLowerCase() === "true") {
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
  }

  if (mcpServers.length) {
    betas.push("mcp-client-2025-11-20");
    for (const server of mcpServers) {
      tools.push({ type: "mcp_toolset", mcp_server_name: server.name });
    }
  }

  const request = {
    model: getModel(),
    max_tokens: getMaxTokens(options.maxTokens),
    system: String(options.systemPrompt || "You are the helpful AI assistant of TOPFEROS MD."),
    messages
  };

  const effort = String(process.env.CLAUDE_EFFORT || "").trim().toLowerCase();
  if (VALID_EFFORTS.includes(effort)) {
    request.output_config = { effort };
  }

  if (String(process.env.CLAUDE_FALLBACKS || "").toLowerCase() !== "off") {
    betas.push("server-side-fallback-2026-07-01");
    request.fallbacks = "default";
  }

  if (tools.length) request.tools = tools;
  if (mcpServers.length) request.mcp_servers = mcpServers;
  if (betas.length) request.betas = betas;

  return request;
}

function extractText(response) {
  return (response?.content || [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();
}

async function runConversation(messages, options = {}) {
  const anthropic = getClient();
  const conversation = [...messages];
  let response = null;

  for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt++) {
    const request = buildRequest(conversation, options);

    try {
      response = await anthropic.beta.messages.create(request);
    } catch (error) {
      console.error("[CLAUDE ERROR]", {
        model: request.model,
        status: error?.status || "UNKNOWN",
        requestId: error?.requestID || error?.request_id,
        message: error?.message || String(error)
      });
      throw error;
    }

    // Zouti sèvè (web search / MCP) ka poze tou a; nou voye l tounen pou l kontinye.
    if (response.stop_reason !== "pause_turn") break;

    conversation.push({ role: "assistant", content: response.content });
  }

  if (response?.stop_reason === "refusal") {
    const error = new Error("Claude declined to answer this request.");
    error.code = "CLAUDE_REFUSAL";
    error.category = response.stop_details?.category || null;
    throw error;
  }

  const answer = extractText(response);

  if (!answer) {
    throw new Error("Claude returned an empty response.");
  }

  return answer;
}

async function askClaude(prompt, options = {}) {
  const text = String(prompt || "").trim();

  if (!text) {
    throw new Error("AI prompt cannot be empty.");
  }

  const history = normalizeHistory(options.history);

  // Evite voye dènye kesyon an de fwa.
  if (
    history.length &&
    history[history.length - 1].role === "user" &&
    history[history.length - 1].content === text
  ) {
    history.pop();
  }

  // Premye mesaj la dwe soti nan "user".
  while (history.length && history[0].role !== "user") {
    history.shift();
  }

  return runConversation(
    [...history, { role: "user", content: text }],
    options
  );
}

async function askClaudeWithImage(prompt, imageBuffer, mimeType = "image/jpeg", options = {}) {
  const text = String(prompt || "").trim();

  if (!text) {
    throw new Error("AI prompt cannot be empty.");
  }

  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Image buffer is empty or invalid.");
  }

  if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) {
    throw new Error("Unsupported image MIME type: " + mimeType);
  }

  return runConversation(
    [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: imageBuffer.toString("base64")
            }
          },
          { type: "text", text }
        ]
      }
    ],
    {
      ...options,
      systemPrompt: options.systemPrompt || "Analyze the image and follow the user's instructions."
    }
  );
}

module.exports = {
  askClaude,
  askClaudeWithImage,
  isClaudeConfigured,
  getClaudeModel: getModel
};
