"use strict";

// 🦁 TOPFEROS MD V2.0.0
// CLAUDE CODE BRIDGE
//
// HTTP API that matches the WhatsApp relay used by manveer/whatsapp-assistant
// (/poll, /send, /react, /mark-read, /send-media), but backed by the bot's
// Baileys sessions instead of the WhatsApp Business API. The MCP channel server
// in mcp/whatsapp-channel.mjs polls these routes so Claude Code can read and
// answer WhatsApp messages.
//
// Konfigirasyon (Environment):
//   CLAUDE_BRIDGE_SECRET    Sekrè pataje (header x-relay-secret). San li, bridge la etenn.
//   CLAUDE_BRIDGE_ALLOWED   Nimewo ki gen dwa pale ak Claude, separe pa vigil.
//                           Default: OWNER_NUMBER. "*" = tout chat prive.
//   CLAUDE_BRIDGE_SELF_CHAT "false" pou pa voye mesaj "Message yourself" yo (default: true)
//   CLAUDE_BRIDGE_GROUPS    "true" pou gwoup yo tou (default: false)

const crypto = require("crypto");
const express = require("express");

const sessionManager = require("../src/sessionManager");
const config = require("../src/config");

const MAX_QUEUE = 500;
const MAX_CACHE = 1000;

const queue = [];
const messageCache = new Map(); // wamid -> { sessionId, key, message }
const chatSessions = new Map(); // chat jid -> sessionId
const sentByBridge = new Set();
let nextId = 1;

// Chanje chak fwa bot la redemare, pou kliyan an konnen kurseur li a pa valab ankò.
const BOOT_ID = crypto.randomUUID();

function getSecret() {
  return String(
    process.env.CLAUDE_BRIDGE_SECRET ||
    process.env.RELAY_SECRET ||
    ""
  ).trim();
}

function isBridgeEnabled() {
  return Boolean(getSecret());
}

function digits(value) {
  return String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function getAllowedNumbers() {
  const raw = String(
    process.env.CLAUDE_BRIDGE_ALLOWED ||
    config.ownerNumber ||
    ""
  ).trim();

  if (raw === "*") return "*";

  return new Set(raw.split(",").map(digits).filter(Boolean));
}

function remember(map, key, value, limit) {
  map.set(key, value);

  if (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

function rememberSent(id) {
  if (!id) return;

  sentByBridge.add(id);

  if (sentByBridge.size > MAX_CACHE) {
    sentByBridge.delete(sentByBridge.values().next().value);
  }
}

function getOwnNumbers(sock, sessionId) {
  return new Set(
    [sessionId, sock?.user?.id, sock?.user?.lid].map(digits).filter(Boolean)
  );
}

function unwrap(message) {
  let content = message || {};

  for (const key of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage"]) {
    if (content[key]?.message) content = content[key].message;
  }

  return content;
}

function describe(content) {
  if (content.conversation) return { type: "text", text: content.conversation };
  if (content.extendedTextMessage) return { type: "text", text: content.extendedTextMessage.text };
  if (content.imageMessage) return { type: "image", text: content.imageMessage.caption, mimeType: content.imageMessage.mimetype };
  if (content.videoMessage) return { type: "video", text: content.videoMessage.caption, mimeType: content.videoMessage.mimetype };
  if (content.audioMessage) return { type: "audio", mimeType: content.audioMessage.mimetype };
  if (content.stickerMessage) return { type: "sticker" };
  if (content.documentMessage) {
    return {
      type: "document",
      text: content.documentMessage.caption,
      mimeType: content.documentMessage.mimetype,
      filename: content.documentMessage.fileName
    };
  }
  if (content.locationMessage) {
    return {
      type: "location",
      latitude: content.locationMessage.degreesLatitude,
      longitude: content.locationMessage.degreesLongitude
    };
  }
  if (content.reactionMessage) {
    return {
      type: "reaction",
      reactionEmoji: content.reactionMessage.text,
      reactionTargetWamid: content.reactionMessage.key?.id
    };
  }

  return { type: Object.keys(content)[0] || "unknown" };
}

/*
|--------------------------------------------------------------------------
| INBOUND: called from src/connection.js for every upserted message
|--------------------------------------------------------------------------
*/

function shouldForward(sock, sessionId, message) {
  const chatJid = String(message?.key?.remoteJid || "");
  const isGroupChat = chatJid.endsWith("@g.us");

  if (!chatJid || chatJid === "status@broadcast" || chatJid.endsWith("@newsletter")) return false;
  if (sentByBridge.has(message.key.id)) return false;
  if (isGroupChat && String(process.env.CLAUDE_BRIDGE_GROUPS || "").toLowerCase() !== "true") return false;

  const ownNumbers = getOwnNumbers(sock, sessionId);

  if (message.key.fromMe) {
    // Sèl mesaj pa w ki pase se sa ou ekri nan "Message yourself".
    const selfChat = !isGroupChat && ownNumbers.has(digits(chatJid));
    return selfChat && String(process.env.CLAUDE_BRIDGE_SELF_CHAT || "true").toLowerCase() !== "false";
  }

  const allowed = getAllowedNumbers();
  if (allowed === "*") return true;

  const sender = digits(message.key.participant || chatJid);
  return allowed.has(sender);
}

function recordInbound(sock, sessionId, message) {
  if (!isBridgeEnabled() || !message?.message || !message.key?.id) return false;
  if (!shouldForward(sock, sessionId, message)) return false;

  const details = describe(unwrap(message.message));

  // Kòmand bot la (.menu, .ai ...) rete pou TOPFEROS.
  const prefix = String(config.prefix || ".");
  if (details.text && prefix && details.text.trim().startsWith(prefix)) return false;

  const chatJid = message.key.remoteJid;
  const timestampSeconds = Number(message.messageTimestamp) || Math.floor(Date.now() / 1000);

  remember(messageCache, message.key.id, { sessionId, key: message.key, message }, MAX_CACHE);
  remember(chatSessions, chatJid, sessionId, MAX_CACHE);

  queue.push({
    id: nextId++,
    timestamp: timestampSeconds * 1000,
    wamid: message.key.id,
    from: chatJid,
    pushName: message.pushName || digits(message.key.participant || chatJid),
    session: sessionId,
    ...details
  });

  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);

  return true;
}

/*
|--------------------------------------------------------------------------
| OUTBOUND HELPERS
|--------------------------------------------------------------------------
*/

function toJid(value) {
  const text = String(value || "").trim();
  if (text.includes("@")) return text;

  const number = digits(text);
  return number ? `${number}@s.whatsapp.net` : "";
}

function resolveSocket(chatJid, requestedSession) {
  const sessionId =
    digits(requestedSession) ||
    chatSessions.get(chatJid) ||
    null;

  if (sessionId) {
    const sock = sessionManager.getSessionSocket(sessionId);
    if (sock) return sock;
  }

  const connected = sessionManager
    .getActiveSessions()
    .filter(session => session.connected && session.sock);

  if (connected.length === 1) return connected[0].sock;

  const error = new Error(
    connected.length
      ? "Several sessions are connected; pass `session` with the bot number."
      : "No connected WhatsApp session."
  );
  error.status = connected.length ? 400 : 503;
  throw error;
}

function quoted(wamid) {
  const cached = wamid ? messageCache.get(String(wamid)) : null;
  return cached ? { quoted: cached.message } : {};
}

async function send(chatJid, session, content, replyTo) {
  const sock = resolveSocket(chatJid, session);
  const sent = await sock.sendMessage(chatJid, content, quoted(replyTo));
  rememberSent(sent?.key?.id);
  return sent?.key?.id || null;
}

/*
|--------------------------------------------------------------------------
| ROUTER
|--------------------------------------------------------------------------
*/

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const router = express.Router();

router.use((req, res, next) => {
  if (!isBridgeEnabled()) {
    return res.status(404).json({ error: "Claude bridge is disabled." });
  }

  if (!safeEqual(req.get("x-relay-secret"), getSecret())) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  return next();
});

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req.body || {}, req));
    } catch (error) {
      res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
  };
}

function required(body, fields) {
  for (const field of fields) {
    if (!body[field]) {
      const error = new Error(`Missing field: ${field}`);
      error.status = 400;
      throw error;
    }
  }
}

router.get("/poll", (req, res) => {
  const since = Number(req.query.since) || 0;
  const boot = String(req.query.boot || "");

  // Si bot la te redemare, kontè a rekòmanse: pa bloke sou yon ansyen kurseur.
  const restarted = (boot && boot !== BOOT_ID) || since >= nextId;
  const effectiveSince = restarted ? 0 : since;
  const messages = queue.filter(item => item.id > effectiveSince);

  res.json({ messages, cursor: Math.max(effectiveSince, nextId - 1), boot: BOOT_ID });
});

router.post("/send", handle(async body => {
  required(body, ["to", "text"]);
  const chatJid = toJid(body.to);
  const wamid = await send(chatJid, body.session, { text: String(body.text) }, body.reply_to);
  return { wamid };
}));

router.post("/react", handle(async body => {
  required(body, ["wamid", "emoji"]);
  const cached = messageCache.get(String(body.wamid));
  const chatJid = cached?.key?.remoteJid || toJid(body.to);

  const key = cached?.key || { remoteJid: chatJid, id: String(body.wamid), fromMe: false };
  const wamid = await send(chatJid, body.session || cached?.sessionId, { react: { text: String(body.emoji), key } });
  return { wamid };
}));

router.post("/mark-read", handle(async body => {
  required(body, ["wamid"]);
  const cached = messageCache.get(String(body.wamid));

  if (!cached) {
    const error = new Error("Unknown wamid (only recent bridged messages can be marked read).");
    error.status = 404;
    throw error;
  }

  const sock = resolveSocket(cached.key.remoteJid, cached.sessionId);
  await sock.readMessages([cached.key]);
  return { ok: true };
}));

router.post("/send-media", handle(async body => {
  required(body, ["to", "type", "url"]);

  const url = String(body.url);
  if (!/^https?:\/\//i.test(url)) {
    const error = new Error("url must be http(s).");
    error.status = 400;
    throw error;
  }

  const caption = body.caption ? String(body.caption) : undefined;
  let content;

  switch (body.type) {
    case "image":
      content = { image: { url }, caption };
      break;
    case "video":
      content = { video: { url }, caption };
      break;
    case "audio":
      content = { audio: { url }, mimetype: "audio/mpeg" };
      break;
    case "document":
      content = {
        document: { url },
        fileName: body.filename ? String(body.filename) : url.split("/").pop() || "file",
        mimetype: "application/octet-stream",
        caption
      };
      break;
    default: {
      const error = new Error("type must be image, document, audio or video.");
      error.status = 400;
      throw error;
    }
  }

  const wamid = await send(toJid(body.to), body.session, content, body.reply_to);
  return { wamid };
}));

module.exports = {
  router,
  recordInbound,
  isBridgeEnabled
};
