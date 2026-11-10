
"use strict";

// 🦁 TOPFEROS MD V2.0.0
// AUTO REACT SERVICE — AI FIRST + CUSTOM EMOJI FALLBACK

const settingPanel = require("../src/settingPanel");
const { askAI } = require("./ai");
const aiReactionService = require("./aiReactionService");

const AI_TIMEOUT_MS = 20000;
const MAX_PROCESSED_MESSAGES = 5000;

const processedMessages = new Map();

/*
|--------------------------------------------------------------------------
| EXTRACT MESSAGE CONTENT
|--------------------------------------------------------------------------
*/

function unwrapMessageContent(message) {
  let content = message?.message || {};

  for (let i = 0; i < 6; i += 1) {
    const wrapper =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message;

    if (!wrapper) break;

    content = wrapper;
  }

  return content;
}

function extractText(message) {
  const content = unwrapMessageContent(message);

  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.audioMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.interactiveResponseMessage?.body?.text ||
    ""
  ).trim();
}

/*
|--------------------------------------------------------------------------
| CLEAN CUSTOM EMOJIS
|--------------------------------------------------------------------------
*/

function cleanEmojiList(value) {
  const input = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];

  const segmenter = new Intl.Segmenter("en", {
    granularity: "grapheme"
  });

  const emojis = [];

  for (const item of input) {
    const text = String(item || "").trim();

    if (!text) continue;

    // Separe lis ki itilize espas, vigil oswa pwen-virgil.
    const tokens = text.split(/[\s,;]+/).filter(Boolean);

    for (const token of tokens) {
      for (const part of segmenter.segment(token)) {
        const emoji = part.segment.trim();

        if (emoji && !emojis.includes(emoji)) {
          emojis.push(emoji);
        }

        if (emojis.length >= 40) {
          return emojis;
        }
      }
    }
  }

  return emojis;
}

/*
|--------------------------------------------------------------------------
| AI TIMEOUT
|--------------------------------------------------------------------------
*/

function withTimeout(promise, timeoutMs = AI_TIMEOUT_MS) {
  let timer;

  return Promise.race([
    Promise.resolve(promise),

    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Auto React AI timeout.")),
        timeoutMs
      );
    })
  ]).finally(() => clearTimeout(timer));
}

/*
|--------------------------------------------------------------------------
| PREVENT DUPLICATE REACTIONS
|--------------------------------------------------------------------------
*/

function rememberMessage(key) {
  if (processedMessages.has(key)) return false;

  processedMessages.set(key, Date.now());

  while (processedMessages.size > MAX_PROCESSED_MESSAGES) {
    const oldest = processedMessages.keys().next().value;

    if (!oldest) break;

    processedMessages.delete(oldest);
  }

  return true;
}

/*
|--------------------------------------------------------------------------
| EXTRACT AI EMOJI
|--------------------------------------------------------------------------
*/

function extractAIEmoji(response) {
  const answer = aiReactionService.extractAIText(response);

  return aiReactionService.extractEmoji(answer);
}

/*
|--------------------------------------------------------------------------
| CHOOSE REACTION EMOJI
|--------------------------------------------------------------------------
| 1. AI chwazi emoji ki adapte ak mesaj la.
| 2. Si AI pa disponib, itilize emoji user mete nan panel la.
| 3. Si pa gen emoji user ni AI, pa reyaji.
|--------------------------------------------------------------------------
*/

async function chooseReactionEmoji(text, configuredEmojis = []) {
  const messageText = String(text || "").trim();

  if (!messageText) return null;

  const allowedEmojis = cleanEmojiList(configuredEmojis);

  /*
  |--------------------------------------------------------------------------
  | CUSTOM EMOJI FALLBACK
  |--------------------------------------------------------------------------
  */

  function customEmojiFallback() {
    if (allowedEmojis.length === 0) {
      return null;
    }

    const index = Math.floor(
      Math.random() * allowedEmojis.length
    );

    const emoji = allowedEmojis[index];

    console.log(
      "[AUTO REACT] Using user's custom emoji fallback:",
      emoji
    );

    return emoji;
  }

  /*
  |--------------------------------------------------------------------------
  | MODE 1: USER CUSTOM EMOJIS
  |--------------------------------------------------------------------------
  */

  if (allowedEmojis.length > 0) {
    try {
      const prompt = [
        "Choose the best WhatsApp reaction for this message.",
        "Understand the meaning, emotion and context.",
        "Choose exactly ONE emoji from the allowed list.",
        "Never invent an emoji outside the list.",
        `Allowed emojis: ${allowedEmojis.join(" ")}`,
        `Message: ${messageText}`,
        "Return only one emoji without explanation."
      ].join("\n");

      const response = await withTimeout(
        askAI(prompt, {
          systemPrompt:
            "You are a WhatsApp reaction selector. " +
            "Choose the most appropriate emoji from the allowed list only. " +
            "Return only one emoji.",

          temperature: 0.1,
          maxTokens: 32
        })
      );

      const emoji = extractAIEmoji(response);

      if (emoji && allowedEmojis.includes(emoji)) {
        console.log(
          "[AUTO REACT] AI selected custom emoji:",
          emoji
        );

        return emoji;
      }

      console.warn(
        "[AUTO REACT] AI returned an invalid emoji. Using custom fallback."
      );

      return customEmojiFallback();

    } catch (error) {
      console.warn(
        "[AUTO REACT] AI unavailable. Using user's custom emojis:",
        error?.message || error
      );

      return customEmojiFallback();
    }
  }

  /*
  |--------------------------------------------------------------------------
  | MODE 2: NO CUSTOM EMOJIS — GEMINI DECIDES
  |--------------------------------------------------------------------------
  */

  try {
    const result = await withTimeout(
      aiReactionService.chooseEmojiWithSource({
        text: messageText,
        caption: messageText,
        mediaType: "text"
      })
    );

    if (
      result?.emoji &&
      (
        result.source === "gemini" ||
        result.source === "gemini-image"
      )
    ) {
      console.log(
        "[AUTO REACT] Gemini selected emoji:",
        result.emoji
      );

      return result.emoji;
    }

    console.warn(
      "[AUTO REACT] Gemini did not return an AI-selected emoji."
    );

    return null;

  } catch (error) {
    console.error(
      "[AUTO REACT] Gemini selection failed:",
      error?.message || error
    );

    return null;
  }
}

/*
|--------------------------------------------------------------------------
| MAIN AUTO REACT HANDLER
|--------------------------------------------------------------------------
*/

async function handleAutoReact({
  sock,
  message,
  sessionId
} = {}) {

  if (!sock || !message?.key || !sessionId) {
    return {
      success: false,
      skipped: true,
      reason: "Missing socket, message, or session ID."
    };
  }

  const jid = String(message.key.remoteJid || "");
  const messageId = String(message.key.id || "");

  if (
    !jid ||
    !messageId ||
    jid === "status@broadcast" ||
    jid.endsWith("@newsletter") ||
    message.key.fromMe === true
  ) {
    return {
      success: false,
      skipped: true,
      reason: "Unsupported or outgoing message."
    };
  }

  /*
  |--------------------------------------------------------------------------
  | LOAD SESSION SETTINGS
  |--------------------------------------------------------------------------
  */

  let automation;

  try {
    const settings =
      settingPanel.getSessionSettings(sessionId);

    automation = settings?.automation || {};

    console.log("[AUTO REACT] Session settings:", {
      sessionId,
      autoReact: automation.autoReact,
      autoReactMode: automation.autoReactMode,
      customEmojiCount: cleanEmojiList(
        automation.autoReactEmojis
      ).length
    });

  } catch (error) {
    console.error(
      "[AUTO REACT] Settings could not be loaded:",
      error?.message || error
    );

    return {
      success: false,
      skipped: true,
      reason: "Settings unavailable."
    };
  }

  /*
  |--------------------------------------------------------------------------
  | CHECK AUTO REACT SWITCH
  |--------------------------------------------------------------------------
  */

  if (automation.autoReact !== true) {
    return {
      success: false,
      skipped: true,
      reason: "Auto React is disabled."
    };
  }

  /*
  |--------------------------------------------------------------------------
  | PRIVATE / GROUP MODE
  |--------------------------------------------------------------------------
  */

  const isGroup = jid.endsWith("@g.us");

  const mode = [
    "all",
    "private",
    "group"
  ].includes(automation.autoReactMode)
    ? automation.autoReactMode
    : "all";

  if (
    (mode === "private" && isGroup) ||
    (mode === "group" && !isGroup)
  ) {
    return {
      success: false,
      skipped: true,
      reason: "Message excluded by Auto React mode."
    };
  }

  /*
  |--------------------------------------------------------------------------
  | DUPLICATE PROTECTION
  |--------------------------------------------------------------------------
  */

  const cacheKey =
    `${sessionId}:${jid}:${messageId}`;

  if (!rememberMessage(cacheKey)) {
    return {
      success: false,
      skipped: true,
      reason: "Message already processed."
    };
  }

  /*
  |--------------------------------------------------------------------------
  | EXTRACT MESSAGE TEXT
  |--------------------------------------------------------------------------
  */

  const text = extractText(message);

  if (!text) {
    processedMessages.delete(cacheKey);

    return {
      success: false,
      skipped: true,
      reason: "Message has no text or caption for AI analysis."
    };
  }

  /*
  |--------------------------------------------------------------------------
  | LOAD USER EMOJIS
  |--------------------------------------------------------------------------
  */

  const configuredEmojis = cleanEmojiList(
    automation.autoReactEmojis
  );

  /*
  |--------------------------------------------------------------------------
  | AI FIRST + CUSTOM FALLBACK
  |--------------------------------------------------------------------------
  */

  const emoji = await chooseReactionEmoji(
    text,
    configuredEmojis
  );

  if (!emoji) {
    processedMessages.delete(cacheKey);

    return {
      success: false,
      skipped: true,
      reason: "No valid AI or custom emoji available."
    };
  }

  /*
  |--------------------------------------------------------------------------
  | SEND WHATSAPP REACTION
  |--------------------------------------------------------------------------
  */

  try {
    await sock.sendMessage(jid, {
      react: {
        text: emoji,
        key: message.key
      }
    });

    const usedFallback =
      configuredEmojis.length > 0 &&
      !configuredEmojis.includes(emoji) === false;

    const result = {
      success: true,
      emoji,

      selection: configuredEmojis.length > 0
        ? "custom-list"
        : "gemini-ai",

      mode,

      chatType: isGroup ? "group" : "private"
    };

    console.log(
      "[AUTO REACT] Reaction successfully sent:",
      result
    );

    return result;

  } catch (error) {
    processedMessages.delete(cacheKey);

    console.error(
      "[AUTO REACT] WhatsApp reaction failed:",
      error?.stack ||
      error?.message ||
      error
    );

    return {
      success: false,
      skipped: false,
      reason: error?.message || "Reaction failed."
    };
  }
}

/*
|--------------------------------------------------------------------------
| CLEAR CACHE
|--------------------------------------------------------------------------
*/

function clearAutoReactCache() {
  processedMessages.clear();
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
  handleAutoReact,
  clearAutoReactCache,
  extractText,
  chooseReactionEmoji
};
