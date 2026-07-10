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
  const badge = route.active ? "ON" : "OFF";
  return `${badge} ${source?.alias || route.sourceChatId} -> ${target?.alias || route.targetChatId}`;
}

function hasReplacement(route) {
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
        { text: "История", callback_data: "menu:replay" },
      ],
      [
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
    `Задержка отправки: ${Math.min(minRelayDelayMs, maxRelayDelayMs)}-${Math.max(minRelayDelayMs, maxRelayDelayMs)} мс`,
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

function buildReplayMenuText() {
  const sources = store.listSources();
  return [
    "Повторная выгрузка",
    "",
    "Выберите source-канал, из которого нужно повторно выгрузить последние посты.",
    "",
    sources.length
      ? sources.map((source) => `• ${source.alias} — ${source.title}`).join("\n")
      : "Source-каналы пока не подключены.",
    "",
    "Команда-альтернатива: `/replay_last source_alias 10`",
    `Бот хранит до ${sourceHistoryLimit} последних постов на каждый source после запуска.`,
  ].join("\n");
}

function buildReplayMenuMarkup() {
  const sourceButtons = store
    .listSources()
    .slice(0, 20)
    .map((source) => [
      {
        text: source.alias,
        callback_data: `replay:source:${source.alias}`,
      },
    ]);

  return {
    inline_keyboard: [
      ...sourceButtons,
      [{ text: "Назад", callback_data: "menu:main" }],
    ],
  };
}

function buildReplayCountOptions() {
  const defaults = [5, 10, 20, 50, 100];
  const filtered = defaults.filter((count) => count <= sourceHistoryLimit);
  return filtered.length ? filtered : [Math.max(1, sourceHistoryLimit)];
}

function buildReplayCountText(source) {
  const historySize = store.getRecentSourcePosts(source.chatId, sourceHistoryLimit).length;
  return [
    `Повторная выгрузка: ${source.alias}`,
    "",
    `Канал: ${source.title}${source.username ? ` (@${source.username})` : ""}`,
    `Сейчас в кэше: ${historySize} постов`,
    "",
    "Выберите, сколько последних постов повторно прогнать по активным маршрутам.",
  ].join("\n");
}

function buildReplayCountMarkup(sourceAlias) {
  const options = buildReplayCountOptions();
  const rows = [];

  for (let index = 0; index < options.length; index += 3) {
    rows.push(
      options.slice(index, index + 3).map((count) => ({
        text: `${count} постов`,
        callback_data: `replay:run:${sourceAlias}:${count}`,
      }))
    );
  }

  rows.push([{ text: "Назад к source", callback_data: "menu:replay" }]);
  return { inline_keyboard: rows };
}

function buildRouteDetailsText(route) {
  const source = store.findChannelById(route.sourceChatId);
  const target = store.findChannelById(route.targetChatId);
  const replacement = hasReplacement(route)
    ? `"${route.findText}" -> "${route.replaceText}"`
    : "Не задана";
  const tailReplacement = route.tailFindText
    ? `от "${summarizeText(route.tailFindText, 32)}" -> "${summarizeText(route.tailReplaceText, 40)}"`
    : "Не задана";
  const filters = buildFilterSummary(route);

  return [
    "Маршрут",
    "",
    `Source: ${source?.title || route.sourceChatId}`,
    `Target: ${target?.title || route.targetChatId}`,
    `Состояние: ${route.active ? "включен" : "выключен"}`,
    `Замена: ${replacement}`,
    `Контактный хвост: ${tailReplacement}`,
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
    "7. Для замены хвоста поста: `/route_tail main promo-1 По всем вопросам пишите или звоните: =>` + новый блок",
    "8. Для BMW-only канала: `/route_include main bmw-only bmw,x5,m5`",
    "",
    "Команды в личке:",
    "• `/menu`",
    "• `/source_add @channel alias`",
    "• `/target_add @channel alias`",
    "• `/target_add alias` + пересланный пост из приватного канала",
    "• `/route_add source target`",
    "• `/route_remove source target`",
    "• `/route_replace source target старый => новый`",
    "• `/route_tail source target маркер => новый блок`",
    "• `/route_clear source target`",
    "• `/route_include source target bmw,x5,m3`",
    "• `/route_exclude source target audi,mercedes`",
    "• `/route_filters_clear source target`",
    "• `/replay_last source 10`",
    "",
    "Поддержка контента:",
    "• текст",
    "• фото / видео / документы / аудио / voice / animation",
    "• альбомы",
    "",
    "Фильтры работают по `text` и `caption` поста.",
    "Если include не задан, маршрут принимает все посты.",
    "Повторная выгрузка работает по тем постам, которые бот уже успел сохранить после запуска.",
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
