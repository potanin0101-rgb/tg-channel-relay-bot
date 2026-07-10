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
