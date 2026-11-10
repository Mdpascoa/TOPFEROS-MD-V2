
"use strict";

const {
  getBaileys
} = require("../services/baileysRuntime");

const {
  getFallbackEmoji,
  chooseEmojiWithSource
} = require("../services/aiReactionService");

/*
|--------------------------------------------------------------------------
| RANDOM INITIAL STATUS EMOJI
|--------------------------------------------------------------------------
*/

const INITIAL_STATUS_EMOJIS = [
  "🤣", "🫵", "🔥", "🐑", "🦁", "💯",
  "💥", "🥃", "🍺", "🎂", "🥰", "😭",
  "🤔", "🤭", "🤩", "🥳", "😎", "🥶",
  "😶‍🌫️", "🫥", "👹", "☠️", "👻", "🥴",
  "👀", "🧠", "🧟", "🧚‍♀️", "🧜‍♂️",
  "🐜", "🕊️", "🌚", "🌈", "🍇", "🎇",
  "🌃", "🌌", "🪦", "🩻", "🎊", "💙",
  "❤️", "💘", "❤️‍🔥", "🔴", "🇭🇹"
];

function getRandomInitialStatusEmoji() {
  return INITIAL_STATUS_EMOJIS[
    Math.floor(
      Math.random() * INITIAL_STATUS_EMOJIS.length
    )
  ];
}

function getPreferredStatusEmojis(options = {}) {
  if (!Array.isArray(options.statusReplyEmojis)) {
    return [];
  }

  return [...new Set(
    options.statusReplyEmojis
      .filter(emoji =>
        typeof emoji === "string" &&
        emoji.trim()
      )
      .map(emoji => emoji.trim())
  )].slice(0, 40);
}

function getInitialStatusEmoji(options = {}) {
  const preferred =
    getPreferredStatusEmojis(options);

  if (preferred.length > 0) {
    return preferred[
      Math.floor(Math.random() * preferred.length)
    ];
  }

  return getRandomInitialStatusEmoji();
}

/*
|--------------------------------------------------------------------------
| TOPFEROS MD V2.0.0
| AUTO STATUS SEEN + AUTO STATUS REACT
|--------------------------------------------------------------------------
| 1. React immediately with ❤️
| 2. Mark status as seen if enabled
| 3. Let AI analyze after the first reaction
| 4. Update emoji only when AI chooses another
| 5. Keep original reaction if AI fails
|--------------------------------------------------------------------------
*/

const STATUS_JID = "status@broadcast";

const PROCESS_CACHE_TIME =
  10 * 60 * 1000;

const processedStatuses = new Map();
const inFlightStatuses = new Set();

/*
|--------------------------------------------------------------------------
| PROCESSED STATUS CACHE
|--------------------------------------------------------------------------
*/

function cleanProcessedCache() {
  const now = Date.now();

  for (const [id, timestamp] of processedStatuses) {
    if (now - timestamp > PROCESS_CACHE_TIME) {
      processedStatuses.delete(id);
    }
  }
}

function getMessageId(message) {
  return message?.key?.id || null;
}

function hasBeenProcessed(id) {
  cleanProcessedCache();
  return processedStatuses.has(id);
}

function markAsProcessed(id) {
  processedStatuses.set(id, Date.now());
  cleanProcessedCache();
}

/*
|--------------------------------------------------------------------------
| GET STATUS CONTENT
|--------------------------------------------------------------------------
*/

function getStatusContent(message) {
  const msg = message?.message;

  if (!msg) {
    return {
      type: "unknown",
      content: null
    };
  }

  if (typeof msg.conversation === "string") {
    return {
      type: "text",
      content: msg.conversation
    };
  }

  if (msg.extendedTextMessage) {
    return {
      type: "text",
      content: msg.extendedTextMessage.text || ""
    };
  }

  for (const type of [
    "image",
    "video",
    "audio",
    "document"
  ]) {
    if (msg[`${type}Message`]) {
      return {
        type,
        content: msg[`${type}Message`]
      };
    }
  }

  return {
    type: "unknown",
    content: null
  };
}

/*
|--------------------------------------------------------------------------
| EXTRACT STATUS TEXT
|--------------------------------------------------------------------------
*/

function extractStatusText(message) {
  const { type, content } =
    getStatusContent(message);

  if (type === "text") {
    return String(content || "").trim();
  }

  if (type === "image" || type === "video") {
    return String(
      content?.caption || ""
    ).trim();
  }

  return "";
}

/*
|--------------------------------------------------------------------------
| DOWNLOAD STATUS MEDIA
|--------------------------------------------------------------------------
*/

async function downloadStatusMedia(message, type) {
  try {
    const {
      downloadContentFromMessage
    } = await getBaileys();
    if (
      !["image", "video", "audio"].includes(type)
    ) {
      return null;
    }

    const mediaMessage =
      message?.message?.[`${type}Message`];

    if (!mediaMessage) {
      return null;
    }

    const stream =
      await downloadContentFromMessage(
        mediaMessage,
        type
      );

    const chunks = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);

  } catch (error) {
    console.error(
      "[STATUS] Media download failed:",
      error?.message || error
    );

    return null;
  }
}

/*
|--------------------------------------------------------------------------
| BUILD AI STATUS DATA
|--------------------------------------------------------------------------
*/

async function buildAIStatusData(message) {
  const content =
    getStatusContent(message);

  const text =
    extractStatusText(message);

  const media =
    ["image", "video", "audio"].includes(content.type)
      ? await downloadStatusMedia(
          message,
          content.type
        )
      : null;

  const mimeType =
    content.type === "image"
      ? content.content?.mimetype || "image/jpeg"
      : content.type === "video"
        ? content.content?.mimetype || "video/mp4"
        : content.type === "audio"
          ? content.content?.mimetype || "audio/ogg"
          : null;

  return {
    text,
    caption: text,
    mediaType: content.type,
    media,
    messageId: getMessageId(message),
    participant:
      message?.key?.participant || null,
    timestamp:
      message?.messageTimestamp || null,
    mimeType
  };
}

/*
|--------------------------------------------------------------------------
| NORMALIZE AI EMOJI
|--------------------------------------------------------------------------
*/

function getAIEmoji(aiResult) {
  if (typeof aiResult === "string") {
    return aiResult.trim() || null;
  }

  return typeof aiResult?.emoji === "string"
    ? aiResult.emoji.trim() || null
    : null;
}

/*
|--------------------------------------------------------------------------
| TOPFEROS MD V2.0.0
| SEND WHATSAPP STATUS REACTION
|--------------------------------------------------------------------------
*/

async function sendStatusReaction(sock, message, emoji) {
  const originalKey = message?.key;
  const participant = originalKey?.participant;

  if (
    !sock ||
    originalKey?.remoteJid !== STATUS_JID ||
    !originalKey?.id ||
    !participant ||
    originalKey.fromMe
  ) {
    throw new Error("Invalid WhatsApp Status message key.");
  }

  const reactionEmoji = String(emoji || "").trim();

  if (!reactionEmoji) {
    throw new Error("Reaction emoji is missing.");
  }

  console.log("[STATUS REACT] Sending:", {
    statusId: originalKey.id,
    participant,
    emoji: reactionEmoji
  });

  try {
    const result = await sock.sendMessage(
      STATUS_JID,
      {
        react: {
          text: reactionEmoji,
          key: originalKey
        }
      },
      {
        statusJidList: [participant]
      }
    );

    console.log("[STATUS REACT] Result:", {
      id: result?.key?.id || null,
      statusId: originalKey.id,
      participant,
      emoji: reactionEmoji
    });

    if (!result?.key?.id) {
  throw new Error(
    "Baileys pa retounen ID pou reyaksyon an."
  );
}

console.log(
  "[STATUS REACT] Message queued; waiting for server confirmation.",
  {
    reactionId: result.key.id,
    statusId: originalKey.id,
    participant
  }
);

return true;
  } catch (error) {
    console.error("[STATUS REACT] Failed:", {
      message: error?.message || String(error),
      statusCode: error?.output?.statusCode || null,
      payload: error?.output?.payload || null,
      participant,
      statusId: originalKey.id
    });

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| PROCESS STATUS
|--------------------------------------------------------------------------
*/

async function processStatus(
  sock,
  message,
  options = {}
) {
  if (!sock || !message?.key) {
    return {
      success: false,
      reason: "Socket or message unavailable."
    };
  }

  if (message.key.remoteJid !== STATUS_JID) {
    return {
      success: false,
      ignored: true,
      reason: "Not a WhatsApp Status."
    };
  }

  if (message.key.fromMe) {
    return {
      success: false,
      ignored: true,
      reason: "Own Status ignored."
    };
  }

  const messageId =
    getMessageId(message);

  const participant =
    message.key.participant;

  if (!messageId || !participant) {
    return {
      success: false,
      reason: "Status ID or participant missing."
    };
  }

  const shouldMarkSeen =
    options.autoStatusSeen !== false;

  const shouldReact =
    options.autoStatusReact === true;

  if (!shouldMarkSeen && !shouldReact) {
    return {
      success: false,
      ignored: true,
      reason: "Status automations are disabled."
    };
  }

 const cacheKey = [
  sock.user?.id || "unknown-session",
  participant,
  messageId
].join(":");

  if (
    hasBeenProcessed(cacheKey) ||
    inFlightStatuses.has(cacheKey)
  ) {
    return {
      success: false,
      ignored: true,
      reason: "Status already processed or in progress."
    };
  }

  inFlightStatuses.add(cacheKey);

  let seen = false;
  let reactionSent = false;
  let emoji = null;

  const errors = [];

  try {

    /*
    |--------------------------------------------------------------------------
    | AUTO STATUS REPLY — AI FIRST
    |--------------------------------------------------------------------------
    */

    if (shouldReact) {
      const preferredEmojis =
        getPreferredStatusEmojis(options);

      try {
        const statusData =
          await buildAIStatusData(message);

        const aiResult =
          await chooseEmojiWithSource(
            statusData,
            preferredEmojis
          );

        emoji = getAIEmoji(aiResult);

        if (!emoji) {
          throw new Error("No valid status emoji selected.");
        }

        await sendStatusReaction(
          sock,
          message,
          emoji
        );

        reactionSent = true;

        console.log(
          "[STATUS REPLY] Reaction sent:",
          {
            statusId: messageId,
            emoji,
            source: aiResult.source,
            customEmojiCount: preferredEmojis.length
          }
        );

      } catch (error) {
        errors.push(
          `status-reply: ${error?.message || String(error)}`
        );

        // Sekou si sèvis AI a pa disponib.
        const fallbackList =
          preferredEmojis.length > 0
            ? preferredEmojis
            : INITIAL_STATUS_EMOJIS;

        emoji = fallbackList[
          Math.floor(Math.random() * fallbackList.length)
        ];

        try {
          await sendStatusReaction(
            sock,
            message,
            emoji
          );

          reactionSent = true;

          console.log(
            "[STATUS REPLY] Fallback reaction sent:",
            emoji
          );

        } catch (fallbackError) {
          errors.push(
            `fallback: ${fallbackError?.message || String(fallbackError)}`
          );

          console.error(
            "[STATUS REPLY] Fallback failed:",
            fallbackError?.message || fallbackError
          );
        }
      }
    }

    /*
    |--------------------------------------------------------------------------
    | AUTO STATUS SEEN
    |--------------------------------------------------------------------------
    */

    if (shouldMarkSeen) {
      try {
        await sock.readMessages([
          {
            remoteJid: STATUS_JID,
            id: messageId,
            participant
          }
        ]);

        seen = true;

        console.log(
          "[STATUS SEEN] Status marked as seen:",
          messageId
        );

      } catch (error) {
        errors.push(
          `seen: ${error?.message || String(error)}`
        );

        console.error(
          "[STATUS SEEN] Failed:",
          error?.stack || error
        );
      }
    }

    if (seen || reactionSent) {
      markAsProcessed(cacheKey);
    }

    return {
      success: seen || reactionSent,
      seen,
      reactionSent,
      emoji,
      errors
    };

  } finally {
    inFlightStatuses.delete(cacheKey);
  }
}

/*
|--------------------------------------------------------------------------
| HANDLE STATUS UPSERT
|--------------------------------------------------------------------------
*/

async function handleStatusUpsert(
  sock,
  event,
  options = {}
) {
  const messages =
    Array.isArray(event?.messages)
      ? event.messages
      : [];

  for (const message of messages) {
    if (
      message?.key?.remoteJid !== STATUS_JID
    ) {
      continue;
    }

    try {
      await processStatus(
        sock,
        message,
        options
      );
    } catch (error) {
      console.error(
        "[STATUS] Processing error:",
        error?.stack || error
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| HANDLE STATUS UPDATE
|--------------------------------------------------------------------------
*/

async function handleStatusUpdate(
  sock,
  updates,
  options = {}
) {
  if (!Array.isArray(updates)) {
    return;
  }

  for (const item of updates) {
    const key =
      item?.key ||
      item?.message?.key ||
      null;

    const content =
      item?.update?.message ||
      item?.message?.message ||
      null;

    if (
      key?.remoteJid !== STATUS_JID ||
      !content
    ) {
      continue;
    }

    try {
      const result =
        await processStatus(
          sock,
          {
            key,
            message: content
          },
          options
        );

      console.log(
        "[STATUS UPDATE]",
        result
      );

    } catch (error) {
      console.error(
        "[STATUS] Update processing error:",
        error?.stack || error
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| ATTACH STATUS HANDLER
|--------------------------------------------------------------------------
*/

function attachStatusHandler(
  sock,
  options = {}
) {
  if (!sock) {
    throw new Error(
      "WhatsApp socket is required."
    );
  }

  if (
    sock.__topferosStatusHandlerAttached
  ) {
    return false;
  }

  sock.__topferosStatusHandlerAttached = true;

  sock.ev.on(
    "messages.upsert",
    async event => {
      try {
        await handleStatusUpsert(
          sock,
          event,
          options
        );
      } catch (error) {
        console.error(
          "[STATUS] Upsert handler error:",
          error?.stack || error
        );
      }
    }
  );

  sock.ev.on(
    "messages.update",
    async updates => {
      try {
        await handleStatusUpdate(
          sock,
          updates,
          options
        );
      } catch (error) {
        console.error(
          "[STATUS] Update processing error:",
          error?.stack || error
        );
      }
    }
  );

  console.log(
    "[STATUS] 🟢 Auto Status React handler attached."
  );

  return true;
}

/*
|--------------------------------------------------------------------------
| CLEAR PROCESSED CACHE
|--------------------------------------------------------------------------
*/

function clearProcessedStatusCache() {
  processedStatuses.clear();
  inFlightStatuses.clear();
}

/*
|--------------------------------------------------------------------------
| GET PROCESSED STATUS COUNT
|--------------------------------------------------------------------------
*/

function getProcessedStatusCount() {
  cleanProcessedCache();
  return processedStatuses.size;
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
  STATUS_JID,
  processStatus,
  attachStatusHandler,
  handleStatusUpsert,
  handleStatusUpdate,
  sendStatusReaction,
  extractStatusText,
  getStatusContent,
  downloadStatusMedia,
  buildAIStatusData,
  clearProcessedStatusCache,
  getProcessedStatusCount
};
