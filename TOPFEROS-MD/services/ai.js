"use strict";

// 🦁 TOPFEROS MD V2.0.0
// AI SERVICE: GEMINI OSWA CLAUDE (KORIJE POU RENDER/COMMONJS)
//
// AI_PROVIDER=gemini | claude chwazi founisè a. Si li pa defini, nou itilize
// Gemini lè GEMINI_API_KEY la, sinon Claude lè ANTHROPIC_API_KEY la.

const {
  askClaude,
  askClaudeWithImage,
  isClaudeConfigured,
  getClaudeModel
} = require("./claudeAI");

let GoogleGenAIInstance = null;

async function loadGoogleGenAI() {
  if (!GoogleGenAIInstance) {
    // Sèvi ak import() dinamik pou evite erè SyntaxError sou Render
    const module = await import("@google/genai");
    GoogleGenAIInstance = module.GoogleGenAI;
  }
  return GoogleGenAIInstance;
}

function getApiKey() {
  return String(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    ""
  ).trim();
}

function getModel() {
  return String(
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash"
  ).trim();
}

function isGeminiConfigured() {
  return Boolean(getApiKey());
}

function getAIProvider() {
  const requested = String(process.env.AI_PROVIDER || "")
    .trim()
    .toLowerCase();

  if (["claude", "anthropic"].includes(requested)) return "claude";
  if (["gemini", "google"].includes(requested)) return "gemini";

  if (isGeminiConfigured()) return "gemini";
  if (isClaudeConfigured()) return "claude";

  return "gemini";
}

function getAIProviderLabel() {
  return getAIProvider() === "claude" ? "Claude AI" : "Gemini AI";
}

function getAIModel() {
  return getAIProvider() === "claude" ? getClaudeModel() : getModel();
}

function isAIConfigured() {
  return getAIProvider() === "claude"
    ? isClaudeConfigured()
    : isGeminiConfigured();
}

async function getAIClient() {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY manke nan Render Environment."
    );
  }

  const GoogleGenAI = await loadGoogleGenAI();
  return new GoogleGenAI({ apiKey });
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
      role: item.role === "user" ? "user" : "model",
      parts: [{ text: item.content.trim() }]
    }));
}

function validNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
}

async function geminiAskWithImage(prompt, imageBuffer, mimeType = "image/jpeg", options = {}) {
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

  // Nou ajoute await isit la paske getAIClient kounye a se yon pwomès (async)
  const ai = await getAIClient();
  const model = getModel();

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        inlineData: {
          mimeType,
          data: imageBuffer.toString("base64")
        }
      },
      {
        text
      }
    ],
    config: {
      systemInstruction: String(
        options.systemPrompt ||
        "Analyze the image and follow the user's instructions."
      ),
      temperature: validNumber(options.temperature, 0.2, 0, 2),
      maxOutputTokens: Math.floor(
        validNumber(options.maxTokens, 30, 128, 8192)
      )
    }
  });

  const answer = String(response?.text || "").trim();

  if (!answer) {
    throw new Error("Gemini returned an empty image analysis.");
  }

  return answer;
}

async function geminiAsk(prompt, options = {}) {
  const text = String(prompt || "").trim();

  if (!text) {
    throw new Error("AI prompt cannot be empty.");
  }

  // Nou ajoute await isit la tou
  const ai = await getAIClient();
  const model = getModel();
  const history = normalizeHistory(options.history);

  // Evite voye dènye kesyon an de fwa.
  if (
    history.length &&
    history[history.length - 1].role === "user" &&
    history[history.length - 1].parts[0].text === text
  ) {
    history.pop();
  }

  const config = {
    systemInstruction: String(
      options.systemPrompt ||
      "You are the helpful AI assistant of TOPFEROS MD."
    ),
    temperature: validNumber(
      options.temperature, 0.7, 0, 2
    ),
    maxOutputTokens: Math.floor(
      validNumber(options.maxTokens, 1500, 128, 8192)
    )
  };

  try {
    const chat = ai.chats.create({
      model,
      history,
      config
    });

    const response = await chat.sendMessage({
      message: text
    });

    const answer = String(
      response?.text || ""
    ).trim();

    if (!answer) {
      throw new Error(
        "Gemini returned an empty response."
      );
    }

    return answer;
  } catch (error) {
    const status =
      error?.status ||
      error?.code ||
      "UNKNOWN";

    console.error("[GEMINI ERROR]", {
      model,
      status,
      message: error?.message || String(error)
    });

    throw error;
  }
}

async function askAI(prompt, options = {}) {
  return getAIProvider() === "claude"
    ? askClaude(prompt, options)
    : geminiAsk(prompt, options);
}

async function askAIWithImage(prompt, imageBuffer, mimeType = "image/jpeg", options = {}) {
  return getAIProvider() === "claude"
    ? askClaudeWithImage(prompt, imageBuffer, mimeType, options)
    : geminiAskWithImage(prompt, imageBuffer, mimeType, options);
}

async function aiChat(prompt, history = [], options = {}) {
  return askAI(prompt, {
    ...options,
    history
  });
}

module.exports = {
  askAI,
  askAIWithImage,
  aiChat,
  isAIConfigured,
  getAIProvider,
  getAIProviderLabel,
  getAIModel
};
