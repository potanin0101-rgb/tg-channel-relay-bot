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

function isPrivateChat(chat) {
  return chat?.type === "private";
}

function routeLabel(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  const badge = route.active ? "ON" : "OFF";
  return `${badge} ${source?.alias || route.sourceChatId} -> ${target?.alias || route.targetChatId}`;
}

function hasReplacement(route) {
  return Boolean(route.findText);
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
  const include = route.includeKeywords?.length
    ? route.includeKeywords.join(", ")
    : "все посты";
  const exclude = route.excludeKeywords?.length
    ? route.excludeKeywords.join(", ")
    : "нет";

  return {
    include,
    exclude,
  };
}

function applyRouteText(text, route) {
  const value = String(text || "");
  if (!value) {
    return { text: value, changed: false };
  }
  if (!route?.findText) {
    return { text: value, changed: false };
  }

  const changed = value.includes(route.findText);
  if (!changed) {
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

function buildAlbumSearchText(messages) {
  return messages
    .map((message) => buildMessageSearchText(message))
    .join("\n")
    .toLowerCase();
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

function buildMainMenuText() {
  const state = store.getState();
  return [
    "Управление ретранслятором",
    "",
    `Админов: ${state.admins.length}`,
    `Source-каналов: ${store.listSources().length}`,
    `Target-каналов: ${store.listTargets().length}`,
    `Маршрутов: ${store.listRoutes().length}`,
    "",
    "MVP-настройка только в личке:",
    "`/source_add @channel_username main`",
    "`/target_add @channel_username promo-1`",
    "",
    "Для приватного канала:",
    "`/source_add main` и затем перешлите любой пост из канала",
  ].join("\n");
}

function buildMainMenuMarkup() {
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
  const routes = store.listRoutes();
  const activeRoutes = routes.filter((route) => route.active);
  return [
    "Статус",
    "",
    `Активных маршрутов: ${activeRoutes.length} из ${routes.length}`,
    `Последний update_id: ${store.getLastUpdateId()}`,
    `Буферов альбомов: ${mediaGroups.size}`,
    "",
    activeRoutes.length
      ? activeRoutes.map((route) => `• ${routeLabel(route)}`).join("\n")
      : "Активных маршрутов пока нет.",
  ].join("\n");
}

function buildChannelsText() {
  const sourceLines = store.listSources().map(
    (channel) =>
      `• ${channel.alias} — ${channel.title}${channel.username ? ` (@${channel.username})` : ""} (${channel.chatId})`
  );
  const targetLines = store.listTargets().map(
    (channel) =>
      `• ${channel.alias} — ${channel.title}${channel.username ? ` (@${channel.username})` : ""} (${channel.chatId})`
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

function buildRoutesMenuText() {
  const routes = store.listRoutes();
  return [
    "Маршруты",
    "",
    routes.length
      ? routes.map((route) => `• ${routeLabel(route)}`).join("\n")
      : "Пока нет ни одного маршрута.",
    "",
    "Через кнопки можно включать и смотреть маршрут.",
    "Добавление: `/route_add source_alias target_alias`",
  ].join("\n");
}

function buildRoutesMenuMarkup() {
  const routeButtons = store
    .listRoutes()
    .slice(0, 20)
    .map((route) => [
      {
        text: route.active ? `✅ ${routeLabel(route)}` : `⏸ ${routeLabel(route)}`,
        callback_data: `route:view:${route.id}`,
      },
    ]);

  return {
    inline_keyboard: [
      ...routeButtons,
      [
        { text: "Создать маршрут", callback_data: "route:create" },
        { text: "Назад", callback_data: "menu:main" },
      ],
    ],
  };
}

function buildRouteDetailsText(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  const replacement = hasReplacement(route)
    ? `"${route.findText}" -> "${route.replaceText}"`
    : "Не задана";
  const filters = buildFilterSummary(route);

  return [
    "Маршрут",
    "",
    `Source: ${source?.title || route.sourceChatId}`,
    `Target: ${target?.title || route.targetChatId}`,
    `Состояние: ${route.active ? "включен" : "выключен"}`,
    `Замена: ${replacement}`,
    `Include: ${filters.include}`,
    `Exclude: ${filters.exclude}`,
    "",
    "Чтобы сменить текст, нажмите кнопку ниже и пришлите:",
    "старый текст => новый текст",
  ].join("\n");
}

function buildRouteDetailsMarkup(route) {
  return {
    inline_keyboard: [
      [
        {
          text: route.active ? "Выключить" : "Включить",
          callback_data: `route:toggle:${route.id}`,
        },
        { text: "Задать замену", callback_data: `route:replace:${route.id}` },
      ],
      [
        { text: "Include-фильтр", callback_data: `route:include:${route.id}` },
        { text: "Exclude-фильтр", callback_data: `route:exclude:${route.id}` },
      ],
      [
        { text: "Очистить замену", callback_data: `route:clear:${route.id}` },
        { text: "Удалить маршрут", callback_data: `route:delete:${route.id}` },
      ],
      [{ text: "Назад к маршрутам", callback_data: "menu:routes" }],
    ],
  };
}

function buildHelpText() {
  return [
    "Как настроить",
    "",
    "1. Добавьте бота администратором в source и target каналы.",
    "2. Для публичного source: `/source_add @mainchannel main`",
    "3. Для публичного target: `/target_add @promochannel promo-1`",
    "4. Для приватного канала: `/target_add promo-1`, затем перешлите любой пост из этого канала в личку боту.",
    "5. В личке боту: `/route_add main promo-1`",
    "6. Для замены номера: `/route_replace main promo-1 +79990000000 => +78880000000`",
    "7. Для BMW-only канала: `/route_include main bmw-only bmw,x5,m5`",
    "",
    "Команды в личке:",
    "• `/menu`",
    "• `/source_add @channel alias`",
    "• `/target_add @channel alias`",
    "• `/target_add alias` + пересланный пост из приватного канала",
    "• `/route_add source target`",
    "• `/route_remove source target`",
    "• `/route_replace source target старый => новый`",
    "• `/route_clear source target`",
    "• `/route_include source target bmw,x5,m3`",
    "• `/route_exclude source target audi,mercedes`",
    "• `/route_filters_clear source target`",
    "",
    "Поддержка контента:",
    "• текст",
    "• фото / видео / документы / аудио / voice / animation",
    "• альбомы",
    "",
    "Фильтры работают по `text` и `caption` поста.",
    "Если include не задан, маршрут принимает все посты.",
    "",
    "Если после замены длина текста меняется, Telegram-форматирование у этого сообщения может не сохраниться.",
  ].join("\n");
}

function parseChannelSetupArgs(rest) {
  const parts = String(rest || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Формат: /source_add @channel или /source_add alias");
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
  const channel = await telegramApi("getChat", {
    chat_id: chatRef,
  });

  if (channel.type !== "channel") {
    throw new Error("Нужен именно Telegram-канал, а не группа или личный чат.");
  }

  return channel;
}

async function registerChannelFromPrivateMessage(message, role, aliasInput, chatRef = "") {
  const alias = normalizeAlias(aliasInput);
  let chat = null;

  if (chatRef) {
    chat = await resolveChannelByRef(chatRef);
  } else {
    chat = extractForwardedChannel(message);
  }

  if (!chat?.id) {
    throw new Error(
      "Не вижу канал. Укажите `@username` канала или перешлите любой пост из него в личку боту."
    );
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
    headers: {
      "content-type": "application/json",
    },
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

function createMessagePayload(chatId, transformedText, entities, extra = {}) {
  const payload = {
    chat_id: chatId,
    text: transformedText.text,
    disable_web_page_preview: true,
    ...extra,
  };

  if (!transformedText.changed && Array.isArray(entities) && entities.length) {
    payload.entities = entities;
  }

  return payload;
}

async function sendTextMessage(chatId, text, options = {}) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...options,
  });
}

async function editTextMessage(chatId, messageId, text, options = {}) {
  return telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
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

async function showMainMenu(chatId) {
  await sendTextMessage(chatId, buildMainMenuText(), {
    reply_markup: buildMainMenuMarkup(),
    parse_mode: "Markdown",
  });
}

async function renderMenuFromCallback(callbackQuery, screen, routeId = "") {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (screen === "main") {
    await editTextMessage(chatId, messageId, buildMainMenuText(), {
      reply_markup: buildMainMenuMarkup(),
      parse_mode: "Markdown",
    });
    return;
  }

  if (screen === "status") {
    await editTextMessage(chatId, messageId, buildStatusText(), {
      reply_markup: {
        inline_keyboard: [[{ text: "Назад", callback_data: "menu:main" }]],
      },
    });
    return;
  }

  if (screen === "channels") {
    await editTextMessage(chatId, messageId, buildChannelsText(), {
      reply_markup: {
        inline_keyboard: [[{ text: "Назад", callback_data: "menu:main" }]],
      },
    });
    return;
  }

  if (screen === "routes") {
    await editTextMessage(chatId, messageId, buildRoutesMenuText(), {
      reply_markup: buildRoutesMenuMarkup(),
      parse_mode: "Markdown",
    });
    return;
  }

  if (screen === "help") {
    await editTextMessage(chatId, messageId, buildHelpText(), {
      reply_markup: {
        inline_keyboard: [[{ text: "Назад", callback_data: "menu:main" }]],
      },
      parse_mode: "Markdown",
    });
    return;
  }

  if (screen === "route" && routeId) {
    const route = store.getRouteById(routeId);
    if (!route) {
      throw new Error("Маршрут уже удален.");
    }
    await editTextMessage(chatId, messageId, buildRouteDetailsText(route), {
      reply_markup: buildRouteDetailsMarkup(route),
    });
  }
}

function parsePrivateCommand(text) {
  const trimmed = String(text || "").trim();
  const [command, ...restParts] = trimmed.split(/\s+/);
  return {
    command: (command || "").toLowerCase(),
    rest: trimmed.slice(command.length).trim(),
    args: restParts,
  };
}

function parseReplaceRule(rawInput) {
  const separator = "=>";
  const index = rawInput.indexOf(separator);
  if (index === -1) {
    throw new Error('Нужен формат: "старый текст => новый текст".');
  }

  const left = rawInput.slice(0, index).trim();
  const right = rawInput.slice(index + separator.length).trim();
  if (!left) {
    throw new Error("Слева должен быть текст, который ищем.");
  }
  return { findText: left, replaceText: right };
}

function parseRouteAliases(rest) {
  const [sourceAlias, targetAlias] = String(rest || "").trim().split(/\s+/);
  if (!sourceAlias || !targetAlias) {
    throw new Error("Нужны два алиаса: source и target.");
  }
  return { sourceAlias, targetAlias };
}

async function handlePrivateSession(message) {
  const session = sessions.get(message.from.id);
  if (!session) return false;

  if (session.kind === "await_channel_registration") {
    let chatRef = "";
    if (message.text?.trim().startsWith("@")) {
      ({ chatRef } = parseChannelSetupArgs(message.text));
    }

    await registerChannelFromPrivateMessage(message, session.role, session.alias, chatRef);
    sessions.delete(message.from.id);
    return true;
  }

  if (session.kind === "await_route_create") {
    const { sourceAlias, targetAlias } = parseRouteAliases(message.text || "");
    const route = store.createRoute(sourceAlias, targetAlias);
    sessions.delete(message.from.id);
    await sendTextMessage(
      message.chat.id,
      `Маршрут создан:\n${routeLabel(route)}`,
      {
        reply_markup: buildRouteDetailsMarkup(route),
      }
    );
    return true;
  }

  if (session.kind === "await_route_replace") {
    const rule = parseReplaceRule(message.text || "");
    const route = store.setRouteReplacement(session.routeId, rule.findText, rule.replaceText);
    sessions.delete(message.from.id);
    await sendTextMessage(message.chat.id, buildRouteDetailsText(route), {
      reply_markup: buildRouteDetailsMarkup(route),
    });
    return true;
  }

  if (session.kind === "await_route_include") {
    const route = store.getRouteById(session.routeId);
    const nextRoute = store.setRouteFilters(session.routeId, {
      includeKeywords: normalizeKeywords(message.text || ""),
      excludeKeywords: route?.excludeKeywords || [],
    });
    sessions.delete(message.from.id);
    await sendTextMessage(message.chat.id, buildRouteDetailsText(nextRoute), {
      reply_markup: buildRouteDetailsMarkup(nextRoute),
    });
    return true;
  }

  if (session.kind === "await_route_exclude") {
    const route = store.getRouteById(session.routeId);
    const nextRoute = store.setRouteFilters(session.routeId, {
      includeKeywords: route?.includeKeywords || [],
      excludeKeywords: normalizeKeywords(message.text || ""),
    });
    sessions.delete(message.from.id);
    await sendTextMessage(message.chat.id, buildRouteDetailsText(nextRoute), {
      reply_markup: buildRouteDetailsMarkup(nextRoute),
    });
    return true;
  }

  return false;
}

async function handlePrivateCommand(message) {
  ensurePrivateAdmin(message);

  if (await handlePrivateSession(message)) {
    return;
  }

  if (!message.text) {
    await sendTextMessage(
      message.chat.id,
      "Жду текстовую команду. Для подключения приватного канала сначала отправьте /source_add alias или /target_add alias."
    );
    return;
  }

  const { command, rest } = parsePrivateCommand(message.text || "");

  if (command === "/start" || command === "/menu") {
    await showMainMenu(message.chat.id);
    return;
  }

  if (command === "/help") {
    await sendTextMessage(message.chat.id, buildHelpText(), {
      parse_mode: "Markdown",
      reply_markup: buildMainMenuMarkup(),
    });
    return;
  }

  if (command === "/source_add" || command === "/target_add") {
    const role = command === "/source_add" ? "source" : "target";
    const { chatRef, alias } = parseChannelSetupArgs(rest);

    if (chatRef) {
      await registerChannelFromPrivateMessage(message, role, alias, chatRef);
      return;
    }

    const forwardedChannel = extractForwardedChannel(message);
    if (forwardedChannel) {
      await registerChannelFromPrivateMessage(message, role, alias);
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
        "Если канал публичный, можно вместо пересылки просто прислать его `@username` следующим сообщением.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (command === "/route_add") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const route = store.createRoute(sourceAlias, targetAlias);
    await sendTextMessage(message.chat.id, buildRouteDetailsText(route), {
      reply_markup: buildRouteDetailsMarkup(route),
    });
    return;
  }

  if (command === "/route_remove") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }
    const routeId = store.buildRouteId(source.chatId, target.chatId);
    store.removeRoute(routeId);
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
    const route = store.setRouteReplacement(
      store.buildRouteId(source.chatId, target.chatId),
      "",
      ""
    );
    await sendTextMessage(message.chat.id, buildRouteDetailsText(route), {
      reply_markup: buildRouteDetailsMarkup(route),
    });
    return;
  }

  if (command === "/route_replace") {
    const match = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
    if (!match) {
      throw new Error("Формат: /route_replace source target старый текст => новый текст");
    }
    const [, sourceAlias, targetAlias, ruleRaw] = match;
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }
    const rule = parseReplaceRule(ruleRaw);
    const route = store.setRouteReplacement(
      store.buildRouteId(source.chatId, target.chatId),
      rule.findText,
      rule.replaceText
    );
    await sendTextMessage(message.chat.id, buildRouteDetailsText(route), {
      reply_markup: buildRouteDetailsMarkup(route),
    });
    return;
  }

  if (command === "/route_include") {
    const match = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
    if (!match) {
      throw new Error("Формат: /route_include source target bmw,x5,m3");
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
      includeKeywords: normalizeKeywords(rawKeywords),
      excludeKeywords: route?.excludeKeywords || [],
    });
    await sendTextMessage(message.chat.id, buildRouteDetailsText(nextRoute), {
      reply_markup: buildRouteDetailsMarkup(nextRoute),
    });
    return;
  }

  if (command === "/route_exclude") {
    const match = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
    if (!match) {
      throw new Error("Формат: /route_exclude source target audi,mercedes");
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
      includeKeywords: route?.includeKeywords || [],
      excludeKeywords: normalizeKeywords(rawKeywords),
    });
    await sendTextMessage(message.chat.id, buildRouteDetailsText(nextRoute), {
      reply_markup: buildRouteDetailsMarkup(nextRoute),
    });
    return;
  }

  if (command === "/route_filters_clear") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const source = store.findChannelByAlias(sourceAlias);
    const target = store.findChannelByAlias(targetAlias);
    if (!source || !target) {
      throw new Error("Не найден source или target канал по алиасу.");
    }
    const nextRoute = store.setRouteFilters(store.buildRouteId(source.chatId, target.chatId), {
      includeKeywords: [],
      excludeKeywords: [],
    });
    await sendTextMessage(message.chat.id, buildRouteDetailsText(nextRoute), {
      reply_markup: buildRouteDetailsMarkup(nextRoute),
    });
    return;
  }

  if (command === "/status") {
    await sendTextMessage(message.chat.id, buildStatusText());
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

  await sendTextMessage(
    message.chat.id,
    `Канал зарегистрирован как ${role}: ${channel.alias}`,
    {}
  );
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
  const transformedText = applyRouteText(message.text, route);
  if (message.text) {
    const payload = createMessagePayload(
      route.targetChatId,
      transformedText,
      message.entities || []
    );
    await telegramApi("sendMessage", payload);
    return;
  }

  const media = getFileIdForMessage(message);
  if (media) {
    const transformedCaption = applyRouteText(message.caption, route);
    const payload = {
      chat_id: route.targetChatId,
      [media.field]: media.fileId,
    };

    if (transformedCaption.text) {
      payload.caption = transformedCaption.text;
    }
    if (!transformedCaption.changed && Array.isArray(message.caption_entities) && message.caption_entities.length) {
      payload.caption_entities = message.caption_entities;
    }

    await telegramApi(media.method, payload);
    return;
  }

  if (!hasReplacement(route)) {
    await telegramApi("copyMessage", {
      chat_id: route.targetChatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
    return;
  }

  throw new Error("Тип сообщения не поддерживает замену текста.");
}

function getAlbumItemDescriptor(message, route) {
  const caption = applyRouteText(message.caption, route);

  if (Array.isArray(message.photo) && message.photo.length) {
    return {
      type: "photo",
      media: message.photo[message.photo.length - 1].file_id,
      caption,
      captionEntities: message.caption_entities || [],
    };
  }

  if (message.video?.file_id) {
    return {
      type: "video",
      media: message.video.file_id,
      caption,
      captionEntities: message.caption_entities || [],
    };
  }

  if (message.document?.file_id) {
    return {
      type: "document",
      media: message.document.file_id,
      caption,
      captionEntities: message.caption_entities || [],
    };
  }

  if (message.audio?.file_id) {
    return {
      type: "audio",
      media: message.audio.file_id,
      caption,
      captionEntities: message.caption_entities || [],
    };
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

    if (descriptor.caption.text) {
      item.caption = descriptor.caption.text;
    }
    if (!descriptor.caption.changed && descriptor.captionEntities.length) {
      item.caption_entities = descriptor.captionEntities;
    }
    media.push(item);
  }

  await telegramApi("sendMediaGroup", {
    chat_id: route.targetChatId,
    media,
  });
}

async function notifyAdmins(text) {
  const admins = store.getState().admins;
  for (const adminId of admins) {
    try {
      await sendTextMessage(adminId, text);
    } catch (error) {
      console.error("Failed to notify admin", adminId, error.message);
    }
  }
}

async function relayChannelPost(message) {
  const sourceChannel = store.findChannelById(message.chat.id);
  if (!sourceChannel) return;
  if (!(sourceChannel.role === "source" || sourceChannel.role === "both")) return;

  const routes = store.listRoutesForSource(message.chat.id);
  if (!routes.length) return;

  if (message.media_group_id) {
    bufferMediaGroup(message, routes);
    return;
  }

  const searchText = buildMessageSearchText(message);
  const filteredRoutes = routes.filter((route) => routeMatchesText(searchText, route));
  if (!filteredRoutes.length) return;

  for (const route of filteredRoutes) {
    try {
      await relaySingleMessage(message, route);
    } catch (error) {
      console.error(`Route ${route.id} failed:`, error.message);
      await notifyAdmins(
        `Не удалось отправить пост по маршруту ${routeLabel(route)}:\n${error.message}`
      );
    }
  }
}

function bufferMediaGroup(message, routes) {
  const key = `${message.chat.id}:${message.media_group_id}`;
  const existing = mediaGroups.get(key);

  if (existing) {
    existing.messages.push(message);
    return;
  }

  const entry = {
    messages: [message],
    routes,
    timer: setTimeout(async () => {
      const current = mediaGroups.get(key);
      if (!current) return;
      mediaGroups.delete(key);

      const sortedMessages = [...current.messages].sort((left, right) => left.message_id - right.message_id);
      const searchText = buildAlbumSearchText(sortedMessages);
      for (const route of current.routes) {
        if (!routeMatchesText(searchText, route)) {
          continue;
        }
        try {
          await relayAlbum(sortedMessages, route);
        } catch (error) {
          console.error(`Album route ${route.id} failed:`, error.message);
          await notifyAdmins(
            `Не удалось отправить альбом по маршруту ${routeLabel(route)}:\n${error.message}`
          );
        }
      }
    }, mediaGroupFlushMs),
  };

  mediaGroups.set(key, entry);
}

async function handleCallbackQuery(callbackQuery) {
  const message = callbackQuery.message;
  if (!message) return;

  ensurePrivateAdmin({
    chat: message.chat,
    from: callbackQuery.from,
  });

  const parts = String(callbackQuery.data || "").split(":");
  const [scope, action, routeId] = parts;

  if (scope === "menu") {
    await renderMenuFromCallback(callbackQuery, action);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (scope === "route" && action === "view") {
    await renderMenuFromCallback(callbackQuery, "route", routeId);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (scope === "route" && action === "toggle") {
    store.toggleRoute(routeId);
    await renderMenuFromCallback(callbackQuery, "route", routeId);
    await answerCallbackQuery(callbackQuery.id, "Статус маршрута обновлен");
    return;
  }

  if (scope === "route" && action === "replace") {
    sessions.set(callbackQuery.from.id, {
      kind: "await_route_replace",
      routeId,
    });
    await answerCallbackQuery(callbackQuery.id, "Жду правило замены в чате");
    await sendTextMessage(
      message.chat.id,
      'Пришлите правило в формате: "старый текст => новый текст"'
    );
    return;
  }

  if (scope === "route" && action === "include") {
    sessions.set(callbackQuery.from.id, {
      kind: "await_route_include",
      routeId,
    });
    await answerCallbackQuery(callbackQuery.id, "Жду include-слова");
    await sendTextMessage(
      message.chat.id,
      "Пришлите include-ключи через запятую. Пример: `bmw,x5,m3`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (scope === "route" && action === "exclude") {
    sessions.set(callbackQuery.from.id, {
      kind: "await_route_exclude",
      routeId,
    });
    await answerCallbackQuery(callbackQuery.id, "Жду exclude-слова");
    await sendTextMessage(
      message.chat.id,
      "Пришлите exclude-ключи через запятую. Пример: `audi,mercedes`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (scope === "route" && action === "clear") {
    store.setRouteReplacement(routeId, "", "");
    await renderMenuFromCallback(callbackQuery, "route", routeId);
    await answerCallbackQuery(callbackQuery.id, "Замена очищена");
    return;
  }

  if (scope === "route" && action === "delete") {
    store.removeRoute(routeId);
    await renderMenuFromCallback(callbackQuery, "routes");
    await answerCallbackQuery(callbackQuery.id, "Маршрут удален");
    return;
  }

  if (scope === "route" && action === "create") {
    sessions.set(callbackQuery.from.id, {
      kind: "await_route_create",
    });
    await answerCallbackQuery(callbackQuery.id, "Жду source и target алиасы");
    await sendTextMessage(
      message.chat.id,
      "Пришлите два алиаса через пробел: `source_alias target_alias`",
      { parse_mode: "Markdown" }
    );
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
