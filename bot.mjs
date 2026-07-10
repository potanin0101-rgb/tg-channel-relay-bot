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
const defaultTailMarker = String(process.env.DEFAULT_TAIL_MARKER || "по всем вопросам").trim();
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

function setUserSession(userId, session) {
  sessions.set(Number(userId), session);
}

function getUserSession(userId) {
  return sessions.get(Number(userId)) || null;
}

function clearUserSession(userId) {
  sessions.delete(Number(userId));
}

function formatChannelLabel(channel) {
  if (!channel) return "не найден";
  return `${channel.title}${channel.username ? ` (@${channel.username})` : ""}`;
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

function routeLabel(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  return `${source?.alias || route.sourceChatId} -> ${target?.alias || route.targetChatId}`;
}

function routeBadge(route) {
  return route.active ? "ON" : "OFF";
}

function hasRewrite(route) {
  return Boolean(route.findText || route.tailFindText);
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
    throw new Error("Формат: @channel alias или alias");
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
    throw new Error("Слева от => должен быть текст для поиска.");
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

function buildMainMenuText() {
  return [
    "Управление ретранслятором",
    "",
    `Source-каналов: ${store.listSources().length}`,
    `Промо-каналов: ${store.listTargets().length}`,
    `Маршрутов: ${store.listRoutes().length}`,
    `Задержка отправки: ${Math.min(minRelayDelayMs, maxRelayDelayMs)}-${Math.max(minRelayDelayMs, maxRelayDelayMs)} мс`,
    "",
    "Основная логика теперь кнопочная:",
    "1. Открываете раздел Промо-каналы",
    "2. Выбираете нужный канал",
    "3. Настраиваете только его маршрут, фильтры и выгрузку истории",
  ].join("\n");
}

function buildMainMenuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "Статус", callback_data: "menu:status" },
        { text: "Промо-каналы", callback_data: "menu:targets" },
      ],
      [
        { text: "Source-каналы", callback_data: "menu:sources" },
        { text: "Подключить", callback_data: "menu:setup" },
      ],
      [{ text: "Помощь", callback_data: "menu:help" }],
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
      ? activeRoutes.map((route) => `• ${routeBadge(route)} ${routeLabel(route)}`).join("\n")
      : "Активных маршрутов пока нет.",
  ].join("\n");
}

function buildSourcesText() {
  const sources = store.listSources();
  return [
    "Source-каналы",
    "",
    sources.length
      ? sources.map((channel) => `• ${channel.alias} — ${formatChannelLabel(channel)}`).join("\n")
      : "Source-каналы пока не подключены.",
    "",
    "Новый source можно добавить кнопкой ниже.",
  ].join("\n");
}

function buildSourcesMarkup() {
  return {
    inline_keyboard: [
      [{ text: "Добавить source", callback_data: "setup:source" }],
      [{ text: "Назад", callback_data: "menu:main" }],
    ],
  };
}

function buildTargetsListText() {
  const targets = store.listTargets();
  return [
    "Промо-каналы",
    "",
    targets.length
      ? targets
          .map((target) => {
            const routes = store.listRoutesForTarget(target.chatId);
            const activeCount = routes.filter((route) => route.active).length;
            return `• ${target.alias} — ${formatChannelLabel(target)} | маршрутов: ${routes.length} | активных: ${activeCount}`;
          })
          .join("\n")
      : "Промо-каналы пока не подключены.",
    "",
    "Откройте нужный канал кнопкой ниже. Все дальнейшие действия будут идти в его контексте.",
  ].join("\n");
}

function buildTargetsListMarkup() {
  const targetButtons = store.listTargets().slice(0, 40).map((target) => {
    const routes = store.listRoutesForTarget(target.chatId);
    return [
      {
        text: `${target.alias} (${routes.length})`,
        callback_data: `target:view:${target.chatId}`,
      },
    ];
  });

  return {
    inline_keyboard: [
      ...targetButtons,
      [{ text: "Добавить промо-канал", callback_data: "setup:target" }],
      [{ text: "Назад", callback_data: "menu:main" }],
    ],
  };
}

function buildTargetDetailsText(target) {
  const routes = store.listRoutesForTarget(target.chatId);
  const routeLines = routes.length
    ? routes
        .map((route) => {
          const source = store.findChannelById(route.sourceChatId);
          return `• ${routeBadge(route)} ${source?.alias || route.sourceChatId}`;
        })
        .join("\n")
    : "Пока нет ни одного привязанного source.";

  return [
    "Промо-канал",
    "",
    `Название: ${formatChannelLabel(target)}`,
    `Алиас: ${target.alias}`,
    `ID: ${target.chatId}`,
    `Маршрутов: ${routes.length}`,
    "",
    routeLines,
    "",
    "Откройте маршрут кнопкой ниже или добавьте новый source в этот канал.",
  ].join("\n");
}

function buildTargetDetailsMarkup(target) {
  const routeButtons = store.listRoutesForTarget(target.chatId).slice(0, 20).map((route) => {
    const source = store.findChannelById(route.sourceChatId);
    return [
      {
        text: `${route.active ? "✅" : "⏸"} ${source?.alias || route.sourceChatId}`,
        callback_data: `route:view:${route.id}`,
      },
    ];
  });

  return {
    inline_keyboard: [
      ...routeButtons,
      [{ text: "Добавить source в этот канал", callback_data: `target:attach:${target.chatId}` }],
      [{ text: "Назад к промо-каналам", callback_data: "menu:targets" }],
    ],
  };
}

function buildSourcePickerText(target) {
  const sources = store.listSources();
  return [
    `Подключение source к ${target.alias}`,
    "",
    sources.length
      ? "Выберите source, который должен копироваться в этот промо-канал."
      : "Сначала добавьте хотя бы один source-канал.",
  ].join("\n");
}

function buildSourcePickerMarkup(target) {
  const sourceButtons = store.listSources().slice(0, 20).map((source) => [
    {
      text: source.alias,
      callback_data: `target:picksource:${target.chatId}:${source.chatId}`,
    },
  ]);

  return {
    inline_keyboard: [
      ...sourceButtons,
      [{ text: "Назад к каналу", callback_data: `target:view:${target.chatId}` }],
    ],
  };
}

function buildRouteDetailsText(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);

  return [
    "Маршрут",
    "",
    `Состояние: ${route.active ? "включен" : "выключен"}`,
    `Source: ${formatChannelLabel(source)}`,
    `Target: ${formatChannelLabel(target)}`,
    `Обычная замена: ${route.findText ? `"${summarizeText(route.findText)}" -> "${summarizeText(route.replaceText)}"` : "не задана"}`,
    `Контактный блок: ${route.tailFindText ? `от "${summarizeText(route.tailFindText, 32)}"` : "не задан"}`,
    buildFilterSummary(route),
    "",
    "История из этого экрана будет выгружаться только в текущий промо-канал, а не во всю сетку.",
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
        { text: "История", callback_data: `route:replaymenu:${route.id}` },
      ],
      [
        { text: "Контактный блок", callback_data: `route:tail:${route.id}` },
        { text: "Замена текста", callback_data: `route:replace:${route.id}` },
      ],
      [
        { text: "Include", callback_data: `route:include:${route.id}` },
        { text: "Exclude", callback_data: `route:exclude:${route.id}` },
      ],
      [
        { text: "Очистить фильтры", callback_data: `route:clearfilters:${route.id}` },
        { text: "Очистить замену", callback_data: `route:clearrewrite:${route.id}` },
      ],
      [{ text: "Удалить маршрут", callback_data: `route:remove:${route.id}` }],
      [{ text: "Назад к промо-каналу", callback_data: `target:view:${route.targetChatId}` }],
    ],
  };
}

function buildReplayMenuText(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  const cached = store.getRecentSourcePosts(route.sourceChatId, sourceHistoryLimit).length;

  return [
    "Повторная выгрузка",
    "",
    `Source: ${formatChannelLabel(source)}`,
    `Target: ${formatChannelLabel(target)}`,
    `Сейчас в кэше source: ${cached} постов`,
    "",
    "Выберите, сколько последних постов прогнать именно в этот промо-канал.",
  ].join("\n");
}

function buildReplayMenuMarkup(route) {
  const counts = [10, 20, 50]
    .filter((count) => count <= sourceHistoryLimit)
    .map((count) => ({
      text: `${count} постов`,
      callback_data: `route:replay:${route.id}:${count}`,
    }));
  const replayRow = counts.length
    ? counts
    : [
        {
          text: `${Math.max(1, sourceHistoryLimit)} постов`,
          callback_data: `route:replay:${route.id}:${Math.max(1, sourceHistoryLimit)}`,
        },
      ];

  return {
    inline_keyboard: [
      replayRow,
      [{ text: "Назад к маршруту", callback_data: `route:view:${route.id}` }],
    ],
  };
}

function buildSetupText() {
  return [
    "Подключение каналов",
    "",
    "1. Добавьте бота администратором в нужный канал.",
    "2. Нажмите нужную кнопку ниже.",
    "3. Для публичного канала отправьте в чат: @username alias",
    "4. Для приватного канала можно сначала отправить alias, затем переслать любой пост из канала.",
  ].join("\n");
}

function buildSetupMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "Добавить source", callback_data: "setup:source" },
        { text: "Добавить promo", callback_data: "setup:target" },
      ],
      [{ text: "Назад", callback_data: "menu:main" }],
    ],
  };
}

function buildHelpText() {
  return [
    "Как теперь работать",
    "",
    "1. Добавьте source и promo-каналы через меню Подключить.",
    "2. Откройте раздел Промо-каналы.",
    "3. Выберите нужный promo-канал кнопкой.",
    "4. Внутри него подключите source, настройте контактный блок, фильтры и историю.",
    "",
    "Кнопки внутри маршрута:",
    "• История — выгружает последние 10 / 20 / 50 постов только в этот promo-канал",
    "• Контактный блок — просит прислать новый хвост поста",
    "• Замена текста — просит прислать правило вида старый => новый",
    "• Include / Exclude — просит прислать ключи через запятую",
    "",
    "Старые команды тоже работают, но основной сценарий теперь кнопочный.",
  ].join("\n");
}

async function showMainMenu(chatId) {
  await sendTextMessage(chatId, buildMainMenuText(), {
    reply_markup: buildMainMenuMarkup(),
  });
}

async function showSourcesScreen(chatId) {
  await sendTextMessage(chatId, buildSourcesText(), {
    reply_markup: buildSourcesMarkup(),
  });
}

async function showTargetsScreen(chatId) {
  await sendTextMessage(chatId, buildTargetsListText(), {
    reply_markup: buildTargetsListMarkup(),
  });
}

async function showTargetDetails(chatId, targetChatId) {
  const target = store.findChannelById(targetChatId);
  if (!target) {
    throw new Error("Промо-канал не найден.");
  }

  await sendTextMessage(chatId, buildTargetDetailsText(target), {
    reply_markup: buildTargetDetailsMarkup(target),
  });
}

async function showRouteDetails(chatId, routeId) {
  const route = store.getRouteById(routeId);
  if (!route) {
    throw new Error("Маршрут не найден.");
  }

  await sendTextMessage(chatId, buildRouteDetailsText(route), {
    reply_markup: buildRouteDetailsMarkup(route),
  });
}

async function renderCallbackScreen(callbackQuery, screen, payload = {}) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (screen === "main") {
    await editTextMessage(chatId, messageId, buildMainMenuText(), {
      reply_markup: buildMainMenuMarkup(),
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

  if (screen === "sources") {
    await editTextMessage(chatId, messageId, buildSourcesText(), {
      reply_markup: buildSourcesMarkup(),
    });
    return;
  }

  if (screen === "targets") {
    await editTextMessage(chatId, messageId, buildTargetsListText(), {
      reply_markup: buildTargetsListMarkup(),
    });
    return;
  }

  if (screen === "setup") {
    await editTextMessage(chatId, messageId, buildSetupText(), {
      reply_markup: buildSetupMarkup(),
    });
    return;
  }

  if (screen === "help") {
    await editTextMessage(chatId, messageId, buildHelpText(), {
      reply_markup: {
        inline_keyboard: [[{ text: "Назад", callback_data: "menu:main" }]],
      },
    });
    return;
  }

  if (screen === "target") {
    const target = store.findChannelById(payload.targetChatId);
    if (!target) throw new Error("Промо-канал не найден.");
    await editTextMessage(chatId, messageId, buildTargetDetailsText(target), {
      reply_markup: buildTargetDetailsMarkup(target),
    });
    return;
  }

  if (screen === "attach-source") {
    const target = store.findChannelById(payload.targetChatId);
    if (!target) throw new Error("Промо-канал не найден.");
    await editTextMessage(chatId, messageId, buildSourcePickerText(target), {
      reply_markup: buildSourcePickerMarkup(target),
    });
    return;
  }

  if (screen === "route") {
    const route = store.getRouteById(payload.routeId);
    if (!route) throw new Error("Маршрут не найден.");
    await editTextMessage(chatId, messageId, buildRouteDetailsText(route), {
      reply_markup: buildRouteDetailsMarkup(route),
    });
    return;
  }

  if (screen === "replay") {
    const route = store.getRouteById(payload.routeId);
    if (!route) throw new Error("Маршрут не найден.");
    await editTextMessage(chatId, messageId, buildReplayMenuText(route), {
      reply_markup: buildReplayMenuMarkup(route),
    });
  }
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

async function registerChannelFromPrivateMessage(message, role, aliasInput = "", chatRef = "") {
  const forwardedChannel = extractForwardedChannel(message);
  const chat = chatRef
    ? await resolveChannelByRef(chatRef)
    : forwardedChannel || (message.chat?.type === "channel" ? message.chat : null);

  if (!chat?.id) {
    throw new Error("Не вижу канал. Укажите @username или перешлите любой пост из него в личку боту.");
  }

  const channel = store.registerChannel(chat, role, aliasInput);
  await sendTextMessage(
    message.chat.id,
    [
      `Канал подключен как ${role}: ${channel.alias}`,
      formatChannelLabel(channel),
      `ID: ${channel.chatId}`,
    ].join("\n")
  );
  return channel;
}

async function replayRoutePosts(adminChatId, routeId, count) {
  const route = store.getRouteById(routeId);
  if (!route) {
    throw new Error("Маршрут не найден.");
  }

  const safeCount = Math.max(1, Math.min(sourceHistoryLimit, Number(count) || 1));
  const entries = store.getRecentSourcePosts(route.sourceChatId, safeCount);
  if (!entries.length) {
    throw new Error("В истории этого source пока нет сохраненных постов.");
  }

  let relayedCount = 0;
  for (const entry of entries) {
    relayedCount += await relayStoredPost(entry.messages, [route], { saveHistory: false });
  }

  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  await sendTextMessage(
    adminChatId,
    [
      "Повторная выгрузка завершена.",
      `Source: ${source?.alias || route.sourceChatId}`,
      `Target: ${target?.alias || route.targetChatId}`,
      `Постов взято из кэша: ${entries.length}`,
      `Сработавших отправок: ${relayedCount}`,
    ].join("\n")
  );
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

function buildRouteFromAliases(sourceAlias, targetAlias) {
  const source = store.findChannelByAlias(sourceAlias);
  const target = store.findChannelByAlias(targetAlias);
  if (!source || !target) {
    throw new Error("Не найден source или target канал по алиасу.");
  }
  return { source, target, routeId: store.buildRouteId(source.chatId, target.chatId) };
}

async function completeChannelSetupFlow(message, role, aliasInput = "", chatRef = "") {
  const channel = await registerChannelFromPrivateMessage(message, role, aliasInput, chatRef);
  clearUserSession(message.from.id);

  if (role === "target") {
    await showTargetDetails(message.chat.id, channel.chatId);
    return;
  }

  await showSourcesScreen(message.chat.id);
}

async function handleChannelSetupSession(message, session) {
  const forwardedChannel = extractForwardedChannel(message);
  const text = String(message.text || "").trim();

  if (forwardedChannel && !text) {
    await completeChannelSetupFlow(message, session.role, session.alias || "");
    return true;
  }

  if (!text) {
    return false;
  }

  const { chatRef, alias } = parseChannelSetupArgs(text);
  if (chatRef) {
    await completeChannelSetupFlow(message, session.role, alias, chatRef);
    return true;
  }

  if (forwardedChannel) {
    await completeChannelSetupFlow(message, session.role, alias || session.alias || "");
    return true;
  }

  setUserSession(message.from.id, {
    kind: "await_channel_registration",
    role: session.role,
    alias: alias || session.alias || "",
  });
  await sendTextMessage(
    message.chat.id,
    [
      `Алиас сохранен: ${normalizeAlias(alias || session.alias || "") || "будет сгенерирован автоматически"}`,
      "Теперь перешлите сюда любой пост из приватного канала.",
      "Либо вместо пересылки просто отправьте @username канала.",
    ].join("\n")
  );
  return true;
}

async function handlePendingSession(message) {
  const session = getUserSession(message.from.id);
  if (!session) return false;

  if (session.kind === "await_channel_setup" || session.kind === "await_channel_registration") {
    return handleChannelSetupSession(message, session);
  }

  if (session.kind === "await_route_replace") {
    const rule = parseReplaceRule(String(message.text || ""));
    const route = store.setRouteReplacement(session.routeId, rule.findText, rule.replaceText);
    clearUserSession(message.from.id);
    await sendTextMessage(message.chat.id, "Обычная замена обновлена.");
    await showRouteDetails(message.chat.id, route.id);
    return true;
  }

  if (session.kind === "await_route_tail") {
    const replaceText = String(message.text || "").trim();
    if (!replaceText) {
      throw new Error("Пришлите новый контактный блок текстом.");
    }
    const route = store.setRouteTailReplacement(
      session.routeId,
      session.tailMarker || defaultTailMarker,
      replaceText
    );
    clearUserSession(message.from.id);
    await sendTextMessage(
      message.chat.id,
      `Контактный блок обновлен. Маркер поиска: "${session.tailMarker || defaultTailMarker}".`
    );
    await showRouteDetails(message.chat.id, route.id);
    return true;
  }

  if (session.kind === "await_route_include") {
    const route = store.setRouteFilters(session.routeId, {
      includeKeywords: normalizeKeywords(message.text),
      excludeKeywords: store.getRouteById(session.routeId)?.excludeKeywords || [],
    });
    clearUserSession(message.from.id);
    await sendTextMessage(message.chat.id, "Include-фильтр обновлен.");
    await showRouteDetails(message.chat.id, route.id);
    return true;
  }

  if (session.kind === "await_route_exclude") {
    const route = store.setRouteFilters(session.routeId, {
      includeKeywords: store.getRouteById(session.routeId)?.includeKeywords || [],
      excludeKeywords: normalizeKeywords(message.text),
    });
    clearUserSession(message.from.id);
    await sendTextMessage(message.chat.id, "Exclude-фильтр обновлен.");
    await showRouteDetails(message.chat.id, route.id);
    return true;
  }

  return false;
}

async function startChannelSetup(chatId, userId, role) {
  setUserSession(userId, {
    kind: "await_channel_setup",
    role,
    alias: "",
  });

  await sendTextMessage(
    chatId,
    [
      role === "source" ? "Подключаем source-канал." : "Подключаем промо-канал.",
      "Для публичного канала отправьте: @username alias",
      "Для приватного канала сначала можно отправить alias, потом переслать любой пост из канала.",
    ].join("\n")
  );
}

async function handlePrivateCommand(message) {
  ensurePrivateAdmin(message);

  const { command, rest } = parseCommand(message.text);

  if (command === "/cancel") {
    clearUserSession(message.from.id);
    await sendTextMessage(message.chat.id, "Текущее действие отменено.");
    await showMainMenu(message.chat.id);
    return;
  }

  if (!command) {
    if (await handlePendingSession(message)) {
      return;
    }
    return;
  }

  clearUserSession(message.from.id);

  if (command === "/start" || command === "/menu") {
    await showMainMenu(message.chat.id);
    return;
  }

  if (command === "/help") {
    await sendTextMessage(message.chat.id, buildHelpText());
    return;
  }

  if (command === "/status") {
    await sendTextMessage(message.chat.id, buildStatusText());
    return;
  }

  if (command === "/sources") {
    await showSourcesScreen(message.chat.id);
    return;
  }

  if (command === "/targets" || command === "/channels") {
    await showTargetsScreen(message.chat.id);
    return;
  }

  if (command === "/routes") {
    const routes = store.listRoutes();
    await sendTextMessage(
      message.chat.id,
      routes.length
        ? routes.map((route) => buildRouteDetailsText(route)).join("\n\n")
        : "Маршрутов пока нет."
    );
    return;
  }

  if (command === "/source_add" || command === "/target_add") {
    const role = command === "/source_add" ? "source" : "target";
    const forwardedChannel = extractForwardedChannel(message);
    const text = String(rest || "").trim();

    if (forwardedChannel && !text) {
      await completeChannelSetupFlow(message, role, "");
      return;
    }

    if (!text) {
      await startChannelSetup(message.chat.id, message.from.id, role);
      return;
    }

    const { chatRef, alias } = parseChannelSetupArgs(text);
    if (chatRef) {
      await completeChannelSetupFlow(message, role, alias, chatRef);
      return;
    }

    if (forwardedChannel) {
      await completeChannelSetupFlow(message, role, alias);
      return;
    }

    setUserSession(message.from.id, {
      kind: "await_channel_registration",
      role,
      alias,
    });
    await sendTextMessage(
      message.chat.id,
      `Теперь перешлите сюда любой пост из канала для алиаса ${normalizeAlias(alias)}.`
    );
    return;
  }

  if (command === "/route_add") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const route = store.createRoute(sourceAlias, targetAlias);
    await showRouteDetails(message.chat.id, route.id);
    return;
  }

  if (command === "/route_remove") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const { routeId } = buildRouteFromAliases(sourceAlias, targetAlias);
    store.removeRoute(routeId);
    await sendTextMessage(message.chat.id, "Маршрут удален.");
    return;
  }

  if (command === "/route_clear") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const { routeId } = buildRouteFromAliases(sourceAlias, targetAlias);
    const route = store.clearRouteRewrites(routeId);
    await showRouteDetails(message.chat.id, route.id);
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
    const { routeId } = buildRouteFromAliases(sourceAlias, targetAlias);
    const rule = parseReplaceRule(ruleRaw);
    const route =
      command === "/route_replace"
        ? store.setRouteReplacement(routeId, rule.findText, rule.replaceText)
        : store.setRouteTailReplacement(routeId, rule.findText, rule.replaceText);

    await showRouteDetails(message.chat.id, route.id);
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
    const { routeId } = buildRouteFromAliases(sourceAlias, targetAlias);
    const route = store.getRouteById(routeId);
    const nextRoute = store.setRouteFilters(routeId, {
      includeKeywords:
        command === "/route_include" ? normalizeKeywords(rawKeywords) : route?.includeKeywords || [],
      excludeKeywords:
        command === "/route_exclude" ? normalizeKeywords(rawKeywords) : route?.excludeKeywords || [],
    });

    await showRouteDetails(message.chat.id, nextRoute.id);
    return;
  }

  if (command === "/route_filters_clear") {
    const { sourceAlias, targetAlias } = parseRouteAliases(rest);
    const { routeId } = buildRouteFromAliases(sourceAlias, targetAlias);
    const route = store.setRouteFilters(routeId, {
      includeKeywords: [],
      excludeKeywords: [],
    });
    await showRouteDetails(message.chat.id, route.id);
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

  await sendTextMessage(message.chat.id, buildHelpText());
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
    return {
      method: "sendPhoto",
      field: "photo",
      fileId: message.photo[message.photo.length - 1].file_id,
    };
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

  clearUserSession(callbackQuery.from.id);

  const [scope, action, arg1, arg2] = String(callbackQuery.data || "").split(":");

  if (scope === "menu") {
    await renderCallbackScreen(callbackQuery, action);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (scope === "setup") {
    await answerCallbackQuery(callbackQuery.id);
    await startChannelSetup(message.chat.id, callbackQuery.from.id, action === "source" ? "source" : "target");
    return;
  }

  if (scope === "target" && action === "view") {
    await renderCallbackScreen(callbackQuery, "target", { targetChatId: arg1 });
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (scope === "target" && action === "attach") {
    await renderCallbackScreen(callbackQuery, "attach-source", { targetChatId: arg1 });
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (scope === "target" && action === "picksource") {
    const route = store.createRouteByIds(arg2, arg1);
    await renderCallbackScreen(callbackQuery, "route", { routeId: route.id });
    await answerCallbackQuery(callbackQuery.id, "Маршрут создан");
    return;
  }

  if (scope === "route" && action === "view") {
    await renderCallbackScreen(callbackQuery, "route", { routeId: arg1 });
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (scope === "route" && action === "toggle") {
    store.toggleRoute(arg1);
    await renderCallbackScreen(callbackQuery, "route", { routeId: arg1 });
    await answerCallbackQuery(callbackQuery.id, "Статус маршрута обновлен");
    return;
  }

  if (scope === "route" && action === "replaymenu") {
    await renderCallbackScreen(callbackQuery, "replay", { routeId: arg1 });
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (scope === "route" && action === "replay") {
    await answerCallbackQuery(callbackQuery.id, "Запускаю выгрузку");
    await replayRoutePosts(message.chat.id, arg1, Number(arg2));
    await renderCallbackScreen(callbackQuery, "route", { routeId: arg1 });
    return;
  }

  if (scope === "route" && action === "replace") {
    setUserSession(callbackQuery.from.id, {
      kind: "await_route_replace",
      routeId: arg1,
    });
    await answerCallbackQuery(callbackQuery.id, "Жду правило замены");
    await sendTextMessage(
      message.chat.id,
      [
        "Пришлите правило в формате:",
        "старый текст => новый текст",
      ].join("\n")
    );
    return;
  }

  if (scope === "route" && action === "tail") {
    const route = store.getRouteById(arg1);
    setUserSession(callbackQuery.from.id, {
      kind: "await_route_tail",
      routeId: arg1,
      tailMarker: route?.tailFindText || defaultTailMarker,
    });
    await answerCallbackQuery(callbackQuery.id, "Жду новый контактный блок");
    await sendTextMessage(
      message.chat.id,
      [
        "Пришлите новый контактный блок одним сообщением.",
        `Бот заменит все, начиная с маркера: "${route?.tailFindText || defaultTailMarker}".`,
      ].join("\n")
    );
    return;
  }

  if (scope === "route" && action === "include") {
    setUserSession(callbackQuery.from.id, {
      kind: "await_route_include",
      routeId: arg1,
    });
    await answerCallbackQuery(callbackQuery.id, "Жду include-слова");
    await sendTextMessage(
      message.chat.id,
      "Пришлите include-ключи через запятую. Пример: bmw,x5,m5"
    );
    return;
  }

  if (scope === "route" && action === "exclude") {
    setUserSession(callbackQuery.from.id, {
      kind: "await_route_exclude",
      routeId: arg1,
    });
    await answerCallbackQuery(callbackQuery.id, "Жду exclude-слова");
    await sendTextMessage(
      message.chat.id,
      "Пришлите exclude-ключи через запятую. Пример: audi,mercedes"
    );
    return;
  }

  if (scope === "route" && action === "clearfilters") {
    store.setRouteFilters(arg1, {
      includeKeywords: [],
      excludeKeywords: [],
    });
    await renderCallbackScreen(callbackQuery, "route", { routeId: arg1 });
    await answerCallbackQuery(callbackQuery.id, "Фильтры очищены");
    return;
  }

  if (scope === "route" && action === "clearrewrite") {
    store.clearRouteRewrites(arg1);
    await renderCallbackScreen(callbackQuery, "route", { routeId: arg1 });
    await answerCallbackQuery(callbackQuery.id, "Замены очищены");
    return;
  }

  if (scope === "route" && action === "remove") {
    const route = store.getRouteById(arg1);
    const targetChatId = route?.targetChatId;
    store.removeRoute(arg1);
    if (targetChatId) {
      await renderCallbackScreen(callbackQuery, "target", { targetChatId });
    }
    await answerCallbackQuery(callbackQuery.id, "Маршрут удален");
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