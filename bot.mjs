import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore, normalizeAlias } from "./config-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname);

function loadLocalEnv() {
  const candidateFiles = [".env.local", ".env"];

  for (const fileName of candidateFiles) {
    const filePath = path.join(rootDir, fileName);
    if (!existsSync(filePath)) continue;

    const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, "");
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadLocalEnv();

const token = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const apiBase = token ? `https://api.telegram.org/bot${token}` : "";
const pollTimeoutSec = Number(process.env.POLL_TIMEOUT_SEC || 30);
const mediaGroupFlushMs = Number(process.env.MEDIA_GROUP_FLUSH_MS || 1500);
const minRelayDelayMs = Number(process.env.MIN_RELAY_DELAY_MS || 300);
const maxRelayDelayMs = Number(process.env.MAX_RELAY_DELAY_MS || 500);
const sourceHistoryLimit = Number(process.env.SOURCE_HISTORY_LIMIT || 100);
const adminUserIds = String(process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => Number(value))
  .filter(Boolean);

const store = new ConfigStore(path.join(rootDir, "data", "config.json"));
store.importAdmins(adminUserIds);

const sessions = new Map();
const mediaGroups = new Map();

function requireToken() {
  if (!token) {
    throw new Error("Нужен TELEGRAM_BOT_TOKEN в .env.local или окружении.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minValue, maxValue) {
  const left = Math.max(0, Number(minValue) || 0);
  const right = Math.max(0, Number(maxValue) || 0);
  const min = Math.min(left, right);
  const max = Math.max(left, right);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function applyRelayDelay() {
  const delayMs = randomBetween(minRelayDelayMs, maxRelayDelayMs);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

function isPrivateChat(chat) {
  return chat?.type === "private";
}

function routeLabel(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  return `${source?.alias || route.sourceChatId} -> ${target?.alias || route.targetChatId}`;
}

function hasRewrite(route) {
  return Boolean(route.findText || route.tailFindText);
}

function summarizeText(value, maxLength = 48) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "не задано";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function findCaseInsensitiveIndex(haystack, needle) {
  return String(haystack || "").toLowerCase().indexOf(String(needle || "").toLowerCase());
}

function normalizeKeywords(rawInput) {
  return [...new Set(
    String(rawInput || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  )];
}

function buildFilterSummary(route) {
  return [
    `Include: ${route.includeKeywords?.length ? route.includeKeywords.join(", ") : "все посты"}`,
    `Exclude: ${route.excludeKeywords?.length ? route.excludeKeywords.join(", ") : "нет"}`,
  ].join("\n");
}

function applyRouteText(text, route) {
  const value = String(text || "");
  if (!value) {
    return { text: value, changed: false };
  }

  if (route?.tailFindText) {
    const matchIndex = findCaseInsensitiveIndex(value, route.tailFindText);
    if (matchIndex !== -1) {
      return {
        text: value.slice(0, matchIndex) + String(route.tailReplaceText || ""),
        changed: true,
      };
    }
  }

  if (!route?.findText) {
    return { text: value, changed: false };
  }

  if (!value.includes(route.findText)) {
    return { text: value, changed: false };
  }

  return {
    text: value.split(route.findText).join(route.replaceText || ""),
    changed: true,
  };
}

function buildMessageSearchText(message) {
  return [message.text || "", message.caption || ""].join("\n").toLowerCase();
}

function buildPostSearchText(messages) {
  return messages.map((message) => buildMessageSearchText(message)).join("\n").toLowerCase();
}

function routeMatchesText(searchText, route) {
  const haystack = String(searchText || "").toLowerCase();
  const includeKeywords = route.includeKeywords || [];
  const excludeKeywords = route.excludeKeywords || [];

  if (includeKeywords.length && !includeKeywords.some((keyword) => haystack.includes(keyword))) {
    return false;
  }
  if (excludeKeywords.some((keyword) => haystack.includes(keyword))) {
    return false;
  }
  return true;
}

function buildMenuText() {
  return [
    "Управление ретранслятором",
    "",
    `Source-каналов: ${store.listSources().length}`,
    `Target-каналов: ${store.listTargets().length}`,
    `Маршрутов: ${store.listRoutes().length}`,
    `Задержка отправки: ${Math.min(minRelayDelayMs, maxRelayDelayMs)}-${Math.max(minRelayDelayMs, maxRelayDelayMs)} мс`,
    "",
    "Быстрый старт в личке с ботом:",
    "`/source_add @artlinemotors main`",
    "`/target_add @wewdwe1 promo-1`",
    "`/route_add main promo-1`",
    "",
    "Для приватного канала:",
    "`/source_add main` и затем перешлите боту любой пост из канала.",
  ].join("\n");
}

function buildMenuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "Статус", callback_data: "menu:status" },
        { text: "Каналы", callback_data: "menu:channels" },
      ],
      [
        { text: "Маршруты", callback_data: "menu:routes" },
        { text: "Помощь", callback_data: "menu:help" },
      ],
      [{ text: "Обновить", callback_data: "menu:main" }],
    ],
  };
}

function buildStatusText() {
  const activeRoutes = store.listRoutes().filter((route) => route.active);
  return [
    "Статус",
    "",
    `Активных маршрутов: ${activeRoutes.length}`,
    `Последний update_id: ${store.getLastUpdateId()}`,
    `Буферов альбомов: ${mediaGroups.size}`,
    `История на source: до ${sourceHistoryLimit} постов`,
    "",
    activeRoutes.length
      ? activeRoutes.map((route) => `• ${routeLabel(route)}`).join("\n")
      : "Активных маршрутов пока нет.",
  ].join("\n");
}

function buildChannelsText() {
  const sourceLines = store.listSources().map(
    (channel) =>
      `• ${channel.alias} — ${channel.title}${channel.username ? ` (@${channel.username})` : ""}`
  );
  const targetLines = store.listTargets().map(
    (channel) =>
      `• ${channel.alias} — ${channel.title}${channel.username ? ` (@${channel.username})` : ""}`
  );

  return [
    "Каналы",
    "",
    "Source:",
    sourceLines.length ? sourceLines.join("\n") : "Пока пусто.",
    "",
    "Target:",
    targetLines.length ? targetLines.join("\n") : "Пока пусто.",
  ].join("\n");
}

function buildRoutesText() {
  const routes = store.listRoutes();
  return [
    "Маршруты",
    "",
    routes.length
      ? routes.map((route) => buildRouteDetailsText(route)).join("\n\n")
      : "Маршрутов пока нет.",
  ].join("\n");
}

function buildHelpText() {
  return [
    "Команды в личке с ботом",
    "",
    "`/menu`",
    "`/status`",
    "`/channels`",
    "`/routes`",
    "`/source_add @channel alias`",
    "`/target_add @channel alias`",
    "`/source_add alias` + переслать пост из приватного канала",
    "`/target_add alias` + переслать пост из приватного канала",
    "`/route_add source target`",
    "`/route_remove source target`",
    "`/route_replace source target старый => новый`",
    "`/route_tail source target маркер => новый_контактный_блок`",
    "`/route_clear source target`",
    "`/route_include source target bmw,x5,m5`",
    "`/route_exclude source target audi,mercedes`",
    "`/route_filters_clear source target`",
    "`/replay_last source 10`",
    "",
    "Повторная выгрузка работает по постам, которые бот уже успел сохранить после запуска.",
  ].join("\n");
}

function buildRouteDetailsText(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  return [
    `${route.active ? "ON" : "OFF"} ${routeLabel(route)}`,
    `Source: ${source?.title || route.sourceChatId}`,
    `Target: ${target?.title || route.targetChatId}`,
    `Замена: ${route.findText ? `"${summarizeText(route.findText)}" -> "${summarizeText(route.replaceText)}"` : "нет"}`,
    `Хвост: ${route.tailFindText ? `"${summarizeText(route.tailFindText)}" -> "${summarizeText(route.tailReplaceText)}"` : "нет"}`,
    buildFilterSummary(route),
  ].join("\n");
}

function parseCommand(messageText) {
  const text = String(messageText || "").trim();
  const match = text.match(/^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return { command: "", rest: "" };
  }
  return {
    command: `/${match[1].toLowerCase()}`,
    rest: (match[2] || "").trim(),
  };
}

function parseChannelSetupArgs(rest) {
  const parts = String(rest || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Формат: /source_add @channel alias или /source_add alias");
  }

  const [first, second] = parts;
  if (first.startsWith("@")) {
    return {
      chatRef: first,
      alias: second || first.slice(1),
    };
  }

  return {
    chatRef: "",
    alias: first,
  };
}

function parseRouteAliases(rest) {
  const [sourceAlias, targetAlias] = String(rest || "").trim().split(/\s+/).filter(Boolean);
  if (!sourceAlias || !targetAlias) {
    throw new Error("Формат: source_alias target_alias");
  }
  return { sourceAlias, targetAlias };
}

function parseReplaceRule(rawInput) {
  const separator = "=>";
  const separatorIndex = String(rawInput || "").indexOf(separator);
  if (separatorIndex === -1) {
    throw new Error("Формат: старый текст => новый текст");
  }

  const findText = rawInput.slice(0, separatorIndex).trim();
  const replaceText = rawInput.slice(separatorIndex + separator.length).trim();
  if (!findText) {
    throw new Error("Слева от => должен быть текст или маркер для поиска.");
  }

  return { findText, replaceText };
}

function extractForwardedChannel(message) {
  const candidates = [message?.reply_to_message, message].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.forward_from_chat?.id && candidate.forward_from_chat.type === "channel") {
      return candidate.forward_from_chat;
    }

    if (candidate.forward_origin?.type === "channel" && candidate.forward_origin.chat?.id) {
      return candidate.forward_origin.chat;
    }
  }

  return null;
}

async function resolveChannelByRef(chatRef) {
  const channel = await telegramApi("getChat", { chat_id: chatRef });
  if (channel.type !== "channel") {
    throw new Error("Нужен именно Telegram-канал, а не группа или личный чат.");
  }
  return channel;
}

async function registerChannelFromPrivateMessage(message, role, aliasInput, chatRef = "") {
  const alias = normalizeAlias(aliasInput);
  const chat = chatRef ? await resolveChannelByRef(chatRef) : extractForwardedChannel(message);

  if (!chat?.id) {
    throw new Error("Не вижу канал. Укажите @username или перешлите любой пост из него в личку боту.");
  }

  const channel = store.registerChannel(chat, role, alias);
  await sendTextMessage(
    message.chat.id,
    [
      `Канал подключен как ${role}: ${channel.alias}`,
      `${channel.title}${channel.username ? ` (@${channel.username})` : ""}`,
      `ID: ${channel.chatId}`,
    ].join("\n")
  );
  return channel;
}

async function telegramApi(method, payload) {
  requireToken();
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method}: ${data.description || "unknown error"}`);
  }
  return data.result;
}

async function sendTextMessage(chatId, text, options = {}) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options,
  });
}

async function editTextMessage(chatId, messageId, text, options = {}) {
  return telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...options,
  });
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  return telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

function ensurePrivateAdmin(message) {
  if (!isPrivateChat(message.chat)) {
    throw new Error("Эта команда работает только в личке с ботом.");
  }
  if (!store.hasAdmins()) {
    store.addAdmin(message.from.id);
  }
  if (!store.isAdmin(message.from.id)) {
    throw new Error("У вас нет доступа к управлению этим ботом.");
  }
}

async function showMenu(chatId) {
  await sendTextMessage(chatId, buildMenuText(), {
    reply_markup: buildMenuMarkup(),
    parse_mode: "Markdown",
  });
}

async function renderMenuFromCallback(callbackQuery, screen) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const screens = {
    main: { text: buildMenuText(), options: { reply_markup: buildMenuMarkup(), parse_mode: "Markdown" } },
    status: { text: buildStatusText(), options: { reply_markup: buildMenuMarkup() } },
    channels: { text: buildChannelsText(), options: { reply_markup: buildMenuMarkup() } },
    routes: { text: buildRoutesText(), options: { reply_markup: buildMenuMarkup() } },
    help: { text: buildHelpText(), options: { reply_markup: buildMenuMarkup(), parse_mode: "Markdown" } },
  };

  const next = screens[screen] || screens.main;
  await editTextMessage(chatId, messageId, next.text, next.options);
}

async function notifyAdmins(text) {
  for (const adminId of store.getState().admins) {
    try {
      await sendTextMessage(adminId, text);
    } catch (error) {
      console.error("Failed to notify admin", adminId, error.message);
    }
  }
}

async function replaySourcePosts(adminChatId, sourceAlias, count) {
  const source = store.findChannelByAlias(sourceAlias);
  if (!source) {
    throw new Error(`Source-канал с алиасом "${sourceAlias}" не найден.`);
  }

  const routes = store.listRoutesForSource(source.chatId);
  if (!routes.length) {
    throw new Error(`Для source "${source.alias}" нет активных маршрутов.`);
  }

  const safeCount = Math.max(1, Math.min(sourceHistoryLimit, Number(count) || 1));
  const entries = store.getRecentSourcePosts(source.chatId, safeCount);
  if (!entries.length) {
    throw new Error(`В истории source "${source.alias}" пока нет сохраненных постов.`);
  }

  let relayedCount = 0;
  for (const entry of entries) {
    relayedCount += await relayStoredPost(entry.messages, routes, { saveHistory: false });
  }

  await sendTextMessage(
    adminChatId,
    `Повторная выгрузка завершена: ${entries.length} постов из ${source.alias}, сработавших маршрутов: ${relayedCount}.`
  );
}

async function handlePendingSession(message) {
  const session = sessions.get(message.from.id);
  if (!session || session.kind !== "await_channel_registration") {
    return false;
  }

  const text = String(message.text || "").trim();
  const chatRef = text.startsWith("@") ? text : "";
  const forwardedChannel = extractForwardedChannel(message);
  if (!chatRef && !forwardedChannel) {
    return false;
  }

  await registerChannelFromPrivateMessage(message, session.role, session.alias, chatRef);
  sessions.delete(message.from.id);
  return true;
}

async function handlePrivateCommand(message) {
  ensurePrivateAdmin(message);

  if (await handlePendingSession(message)) {
    return;
  }

  const { command, rest } = parseCommand(message.text);
  if (!command) return;

  if (command === "/start" || command === "/menu") {
    await showMenu(message.chat.id);
    return;
  }

  if (command === "/status") {
    await sendTextMessage(message.chat.id, buildStatusText());
    return;
  }

  if (command === "/channels") {
    await sendTextMessage(message.chat.id, buildChannelsText());
    return;
  }

  if (command === "/routes") {
    await sendTextMessage(message.chat.id, buildRoutesText());
    return;
  }

  if (command === "/help") {
    await sendTextMessage(message.chat.id, buildHelpText(), { parse_mode: "Markdown" });
    return;
  }

  if (command === "/source_add" || command === "/target_add") {
    const role = command === "/source_add" ? "source" : "target";
    const { chatRef, alias } = parseChannelSetupArgs(rest);

    if (chatRef || extractForwardedChannel(message)) {
      await registerChannelFromPrivateMessage(message, role, alias, chatRef);
      return;
    }

    sessions.set(message.from.id, {
      kind: "await_channel_registration",
      role,
      alias,
    });
    await sendTextMessage(
      message.chat.id,
      [
        `Ок, подключаем ${role}-канал с алиасом \`${normalizeAlias(alias)}\`.`,
        "Теперь перешлите в этот чат любой пост из нужного канала.",
        "Если канал публичный, можно следующим сообщением просто прислать его `@username`.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (command === "/route_add") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const route = store.createRoute(sourceAlias, targetAlias);
    await sendTextMessage(message.chat.id, buildRouteDetailsText(route));
    return;
  }

  if (command === "/route_remove") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }
    store.removeRoute(store.buildRouteId(source.chatId, target.chatId));
    await sendTextMessage(message.chat.id, `Маршрут удален: ${source.alias} -> ${target.alias}`);
    return;
  }

  if (command === "/route_clear") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }
    const route = store.clearRouteRewrites(store.buildRouteId(source.chatId, target.chatId));
    await sendTextMessage(message.chat.id, buildRouteDetailsText(route));
    return;
  }

  if (command === "/route_replace" || command === "/route_tail") {
    const match = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
    if (!match) {
      throw new Error(
        command === "/route_replace"
          ? "Формат: /route_replace source target старый текст => новый текст"
          : "Формат: /route_tail source target маркер => новый блок"
      );
    }

    const [, sourceAlias, targetAlias, ruleRaw] = match;
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }

    const rule = parseReplaceRule(ruleRaw);
    const routeId = store.buildRouteId(source.chatId, target.chatId);
    const route =
      command === "/route_replace"
        ? store.setRouteReplacement(routeId, rule.findText, rule.replaceText)
        : store.setRouteTailReplacement(routeId, rule.findText, rule.replaceText);

    await sendTextMessage(message.chat.id, buildRouteDetailsText(route));
    return;
  }

  if (command === "/route_include" || command === "/route_exclude") {
    const match = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
    if (!match) {
      throw new Error(
        command === "/route_include"
          ? "Формат: /route_include source target bmw,x5,m5"
          : "Формат: /route_exclude source target audi,mercedes"
      );
    }

    const [, sourceAlias, targetAlias, rawKeywords] = match;
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }

    const routeId = store.buildRouteId(source.chatId, target.chatId);
    const route = store.getRouteById(routeId);
    const nextRoute = store.setRouteFilters(routeId, {
      includeKeywords:
        command === "/route_include" ? normalizeKeywords(rawKeywords) : route?.includeKeywords || [],
      excludeKeywords:
        command === "/route_exclude" ? normalizeKeywords(rawKeywords) : route?.excludeKeywords || [],
    });

    await sendTextMessage(message.chat.id, buildRouteDetailsText(nextRoute));
    return;
  }

  if (command === "/route_filters_clear") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }

    const route = store.setRouteFilters(store.buildRouteId(source.chatId, target.chatId), {
      includeKeywords: [],
      excludeKeywords: [],
    });
    await sendTextMessage(message.chat.id, buildRouteDetailsText(route));
    return;
  }

  if (command === "/replay_last") {
    const [sourceAlias, countRaw] = String(rest || "").trim().split(/\s+/);
    if (!sourceAlias) {
      throw new Error("Формат: /replay_last source_alias 10");
    }
    await replaySourcePosts(message.chat.id, sourceAlias, Number(countRaw));
    return;
  }

  await sendTextMessage(message.chat.id, buildHelpText(), { parse_mode: "Markdown" });
}

async function handleChannelRegistration(message) {
  const text = String(message.text || "").trim();
  const sourceMatch = text.match(/^\/register_source(?:@\S+)?(?:\s+([a-zA-Z0-9_-]+))?$/i);
  const targetMatch = text.match(/^\/register_target(?:@\S+)?(?:\s+([a-zA-Z0-9_-]+))?$/i);

  if (!sourceMatch && !targetMatch) {
    return false;
  }

  const role = sourceMatch ? "source" : "target";
  const alias = sourceMatch?.[1] || targetMatch?.[1] || "";
  const channel = store.registerChannel(message.chat, role, alias);
  await notifyAdmins(`Канал зарегистрирован как ${role}: ${channel.alias}`);
  return true;
}

function getFileIdForMessage(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    return { method: "sendPhoto", field: "photo", fileId: message.photo[message.photo.length - 1].file_id };
  }
  if (message.video?.file_id) {
    return { method: "sendVideo", field: "video", fileId: message.video.file_id };
  }
  if (message.document?.file_id) {
    return { method: "sendDocument", field: "document", fileId: message.document.file_id };
  }
  if (message.audio?.file_id) {
    return { method: "sendAudio", field: "audio", fileId: message.audio.file_id };
  }
  if (message.animation?.file_id) {
    return { method: "sendAnimation", field: "animation", fileId: message.animation.file_id };
  }
  if (message.voice?.file_id) {
    return { method: "sendVoice", field: "voice", fileId: message.voice.file_id };
  }
  return null;
}

async function relaySingleMessage(message, route) {
  if (!hasRewrite(route)) {
    await telegramApi("copyMessage", {
      chat_id: route.targetChatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
    return;
  }

  if (message.text) {
    const transformed = applyRouteText(message.text, route);
    const payload = {
      chat_id: route.targetChatId,
      text: transformed.text,
      disable_web_page_preview: true,
    };
    if (!transformed.changed && Array.isArray(message.entities) && message.entities.length) {
      payload.entities = message.entities;
    }
    await telegramApi("sendMessage", payload);
    return;
  }

  const media = getFileIdForMessage(message);
  if (media) {
    const transformed = applyRouteText(message.caption, route);
    const payload = {
      chat_id: route.targetChatId,
      [media.field]: media.fileId,
    };
    if (transformed.text) {
      payload.caption = transformed.text;
    }
    if (!transformed.changed && Array.isArray(message.caption_entities) && message.caption_entities.length) {
      payload.caption_entities = message.caption_entities;
    }
    await telegramApi(media.method, payload);
    return;
  }

  throw new Error("Тип сообщения не поддерживает замену текста.");
}

function getAlbumItemDescriptor(message, route) {
  const transformed = applyRouteText(message.caption, route);

  if (Array.isArray(message.photo) && message.photo.length) {
    return { type: "photo", media: message.photo[message.photo.length - 1].file_id, transformed };
  }
  if (message.video?.file_id) {
    return { type: "video", media: message.video.file_id, transformed };
  }
  if (message.document?.file_id) {
    return { type: "document", media: message.document.file_id, transformed };
  }
  if (message.audio?.file_id) {
    return { type: "audio", media: message.audio.file_id, transformed };
  }

  return null;
}

async function relayAlbum(messages, route) {
  const media = [];

  for (const message of messages) {
    const descriptor = getAlbumItemDescriptor(message, route);
    if (!descriptor) {
      throw new Error("Один из элементов альбома не поддержан.");
    }

    const item = {
      type: descriptor.type,
      media: descriptor.media,
    };

    if (descriptor.transformed.text) {
      item.caption = descriptor.transformed.text;
    }
    if (
      !descriptor.transformed.changed &&
      Array.isArray(message.caption_entities) &&
      message.caption_entities.length
    ) {
      item.caption_entities = message.caption_entities;
    }

    media.push(item);
  }

  await telegramApi("sendMediaGroup", {
    chat_id: route.targetChatId,
    media,
  });
}

async function sendPostToRoute(messages, route) {
  await applyRelayDelay();
  if (messages.length === 1) {
    await relaySingleMessage(messages[0], route);
    return;
  }
  await relayAlbum(messages, route);
}

async function relayStoredPost(messages, routes, options = {}) {
  if (!Array.isArray(messages) || !messages.length) return 0;

  const sortedMessages =
    messages.length > 1
      ? [...messages].sort((left, right) => left.message_id - right.message_id)
      : messages;

  if (options.saveHistory !== false) {
    store.appendSourcePost(sortedMessages[0].chat.id, sortedMessages, sourceHistoryLimit);
  }

  const searchText = buildPostSearchText(sortedMessages);
  const matchedRoutes = routes.filter((route) => routeMatchesText(searchText, route));
  if (!matchedRoutes.length) return 0;

  for (const route of matchedRoutes) {
    try {
      await sendPostToRoute(sortedMessages, route);
    } catch (error) {
      console.error(`Route ${route.id} failed:`, error.message);
      await notifyAdmins(`Не удалось отправить пост по маршруту ${routeLabel(route)}:\n${error.message}`);
    }
  }

  return matchedRoutes.length;
}

async function relayChannelPost(message) {
  const sourceChannel = store.findChannelById(message.chat.id);
  if (!sourceChannel || !(sourceChannel.role === "source" || sourceChannel.role === "both")) {
    return;
  }

  const routes = store.listRoutesForSource(message.chat.id);
  if (!routes.length) return;

  if (message.media_group_id) {
    bufferMediaGroup(message, routes);
    return;
  }

  await relayStoredPost([message], routes);
}

function bufferMediaGroup(message, routes) {
  const key = `${message.chat.id}:${message.media_group_id}`;
  const current = mediaGroups.get(key);
  if (current) {
    current.messages.push(message);
    return;
  }

  mediaGroups.set(key, {
    messages: [message],
    routes,
    timer: setTimeout(async () => {
      const entry = mediaGroups.get(key);
      if (!entry) return;
      mediaGroups.delete(key);

      const sortedMessages = [...entry.messages].sort((left, right) => left.message_id - right.message_id);
      await relayStoredPost(sortedMessages, entry.routes);
    }, mediaGroupFlushMs),
  });
}

async function handleCallbackQuery(callbackQuery) {
  const message = callbackQuery.message;
  if (!message) return;

  ensurePrivateAdmin({
    chat: message.chat,
    from: callbackQuery.from,
  });

  const [scope, screen] = String(callbackQuery.data || "").split(":");
  if (scope === "menu") {
    await renderMenuFromCallback(callbackQuery, screen);
    await answerCallbackQuery(callbackQuery.id);
  }
}

async function handleMessageUpdate(message) {
  try {
    if (isPrivateChat(message.chat)) {
      await handlePrivateCommand(message);
      return;
    }

    if (await handleChannelRegistration(message)) {
      return;
    }
  } catch (error) {
    console.error("Message handling error:", error.message);
    if (isPrivateChat(message.chat)) {
      await sendTextMessage(message.chat.id, `Ошибка: ${error.message}`);
    }
  }
}

async function pollOnce() {
  const updates = await telegramApi("getUpdates", {
    timeout: pollTimeoutSec,
    offset: store.getLastUpdateId() || 0,
    allowed_updates: ["message", "channel_post", "callback_query"],
  });

  for (const update of updates) {
    store.setLastUpdateId(update.update_id + 1);

    if (update.message) {
      await handleMessageUpdate(update.message);
    }

    if (update.channel_post) {
      try {
        if (!(await handleChannelRegistration(update.channel_post))) {
          await relayChannelPost(update.channel_post);
        }
      } catch (error) {
        console.error("Channel post handling error:", error.message);
        await notifyAdmins(`Ошибка обработки channel_post:\n${error.message}`);
      }
    }

    if (update.callback_query) {
      try {
        await handleCallbackQuery(update.callback_query);
      } catch (error) {
        console.error("Callback handling error:", error.message);
        await answerCallbackQuery(update.callback_query.id, error.message.slice(0, 180));
      }
    }
  }
}

async function main() {
  console.log("Relay bootstrap started");
  requireToken();
  console.log("Telegram channel relay bot polling started");

  while (true) {
    try {
      await pollOnce();
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(3000);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});