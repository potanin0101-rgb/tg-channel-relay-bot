import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_STATE = {
  version: 1,
  lastUpdateId: 0,
  admins: [],
  channels: {},
  routes: {},
  sourceHistory: {},
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeState(rawState = {}) {
  return {
    ...deepClone(DEFAULT_STATE),
    ...rawState,
    channels: {
      ...deepClone(DEFAULT_STATE.channels),
      ...(rawState.channels || {}),
    },
    routes: {
      ...deepClone(DEFAULT_STATE.routes),
      ...(rawState.routes || {}),
    },
    sourceHistory: {
      ...deepClone(DEFAULT_STATE.sourceHistory),
      ...(rawState.sourceHistory || {}),
    },
    admins: Array.isArray(rawState.admins) ? [...rawState.admins] : [],
  };
}

export function normalizeAlias(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildDefaultAlias(title, chatId) {
  const base = normalizeAlias(title);
  if (base) return base;
  return `channel-${String(chatId).replace(/[^0-9-]/g, "")}`;
}

function nextRole(currentRole, requestedRole) {
  if (!currentRole) return requestedRole;
  if (currentRole === requestedRole) return currentRole;
  return "both";
}

export class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = mergeState();
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) {
      this.save();
      return this.state;
    }

    const raw = readFileSync(this.filePath, "utf-8");
    this.state = mergeState(JSON.parse(raw));
    return this.state;
  }

  save() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2) + "\n", "utf-8");
  }

  getState() {
    return this.state;
  }

  getLastUpdateId() {
    return Number(this.state.lastUpdateId || 0);
  }

  setLastUpdateId(updateId) {
    this.state.lastUpdateId = Number(updateId || 0);
    this.save();
  }

  hasAdmins() {
    return this.state.admins.length > 0;
  }

  isAdmin(userId) {
    return this.state.admins.includes(Number(userId));
  }

  addAdmin(userId) {
    const numericId = Number(userId);
    if (!this.isAdmin(numericId)) {
      this.state.admins.push(numericId);
      this.save();
    }
  }

  importAdmins(userIds) {
    const nextAdmins = [...new Set((userIds || []).map((value) => Number(value)).filter(Boolean))];
    if (!nextAdmins.length) return;
    this.state.admins = [...new Set([...this.state.admins, ...nextAdmins])];
    this.save();
  }

  listChannels() {
    return Object.values(this.state.channels).sort((left, right) =>
      left.alias.localeCompare(right.alias, "ru")
    );
  }

  listSources() {
    return this.listChannels().filter((channel) => channel.role === "source" || channel.role === "both");
  }

  listTargets() {
    return this.listChannels().filter((channel) => channel.role === "target" || channel.role === "both");
  }

  findChannelById(chatId) {
    return this.state.channels[String(chatId)] || null;
  }

  findChannelByAlias(alias) {
    const normalized = normalizeAlias(alias);
    return this.listChannels().find((channel) => channel.alias === normalized) || null;
  }

  registerChannel(chat, role, aliasInput) {
    const chatId = String(chat.id);
    const existing = this.findChannelById(chat.id);
    const alias = normalizeAlias(aliasInput) || existing?.alias || buildDefaultAlias(chat.title, chat.id);
    const aliasOwner = this.findChannelByAlias(alias);

    if (aliasOwner && String(aliasOwner.chatId) !== chatId) {
      throw new Error(`Алиас "${alias}" уже занят каналом ${aliasOwner.title}.`);
    }

    const channel = {
      chatId: Number(chat.id),
      title: chat.title || existing?.title || alias,
      username: chat.username || existing?.username || "",
      alias,
      type: chat.type || existing?.type || "channel",
      role: nextRole(existing?.role, role),
      updatedAt: new Date().toISOString(),
    };

    this.state.channels[chatId] = channel;
    this.save();
    return channel;
  }

  buildRouteId(sourceChatId, targetChatId) {
    return `${sourceChatId}__${targetChatId}`;
  }

  listRoutes() {
    return Object.values(this.state.routes).sort((left, right) => {
      const leftLabel = `${this.findChannelById(left.sourceChatId)?.alias || left.sourceChatId}:${this.findChannelById(left.targetChatId)?.alias || left.targetChatId}`;
      const rightLabel = `${this.findChannelById(right.sourceChatId)?.alias || right.sourceChatId}:${this.findChannelById(right.targetChatId)?.alias || right.targetChatId}`;
      return leftLabel.localeCompare(rightLabel, "ru");
    });
  }

  listRoutesForSource(sourceChatId) {
    return this.listRoutes().filter(
      (route) => Number(route.sourceChatId) === Number(sourceChatId) && route.active
    );
  }

  listRoutesForTarget(targetChatId) {
    return this.listRoutes().filter(
      (route) => Number(route.targetChatId) === Number(targetChatId)
    );
  }

  getRouteById(routeId) {
    return this.state.routes[routeId] || null;
  }

  appendSourcePost(sourceChatId, messages, limit = 100) {
    const key = String(sourceChatId);
    const nextLimit = Math.max(1, Number(limit) || 100);
    const currentHistory = Array.isArray(this.state.sourceHistory[key])
      ? this.state.sourceHistory[key]
      : [];

    const nextEntry = {
      savedAt: new Date().toISOString(),
      messages: JSON.parse(JSON.stringify(messages || [])),
    };

    this.state.sourceHistory[key] = [...currentHistory, nextEntry].slice(-nextLimit);
    this.save();
    return nextEntry;
  }

  getRecentSourcePosts(sourceChatId, count = 10) {
    const key = String(sourceChatId);
    const history = Array.isArray(this.state.sourceHistory[key]) ? this.state.sourceHistory[key] : [];
    const nextCount = Math.max(1, Number(count) || 10);
    return history.slice(-nextCount);
  }

  createRoute(sourceAlias, targetAlias) {
    const source = this.findChannelByAlias(sourceAlias);
    const target = this.findChannelByAlias(targetAlias);

    if (!source) {
      throw new Error(`Не найден source-канал с алиасом "${sourceAlias}".`);
    }
    if (!target) {
      throw new Error(`Не найден target-канал с алиасом "${targetAlias}".`);
    }
    if (!(source.role === "source" || source.role === "both")) {
      throw new Error(`Канал ${source.alias} не зарегистрирован как source.`);
    }
    if (!(target.role === "target" || target.role === "both")) {
      throw new Error(`Канал ${target.alias} не зарегистрирован как target.`);
    }

    const routeId = this.buildRouteId(source.chatId, target.chatId);
    const existing = this.getRouteById(routeId);
    if (existing) return existing;

    const route = {
      id: routeId,
      sourceChatId: source.chatId,
      targetChatId: target.chatId,
      active: true,
      findText: "",
      replaceText: "",
      tailFindText: "",
      tailReplaceText: "",
      includeKeywords: [],
      excludeKeywords: [],
      updatedAt: new Date().toISOString(),
    };

    this.state.routes[routeId] = route;
    this.save();
    return route;
  }

  createRouteByIds(sourceChatId, targetChatId) {
    const source = this.findChannelById(sourceChatId);
    const target = this.findChannelById(targetChatId);

    if (!source) {
      throw new Error(`Не найден source-канал с id "${sourceChatId}".`);
    }
    if (!target) {
      throw new Error(`Не найден target-канал с id "${targetChatId}".`);
    }

    return this.createRoute(source.alias, target.alias);
  }

  removeRoute(routeId) {
    if (!this.state.routes[routeId]) {
      throw new Error("Маршрут не найден.");
    }
    delete this.state.routes[routeId];
    this.save();
  }

  toggleRoute(routeId) {
    const route = this.getRouteById(routeId);
    if (!route) {
      throw new Error("Маршрут не найден.");
    }
    route.active = !route.active;
    route.updatedAt = new Date().toISOString();
    this.save();
    return route;
  }

  setRouteReplacement(routeId, findText, replaceText) {
    const route = this.getRouteById(routeId);
    if (!route) {
      throw new Error("Маршрут не найден.");
    }
    route.findText = String(findText || "");
    route.replaceText = String(replaceText || "");
    route.updatedAt = new Date().toISOString();
    this.save();
    return route;
  }

  setRouteTailReplacement(routeId, findText, replaceText) {
    const route = this.getRouteById(routeId);
    if (!route) {
      throw new Error("Маршрут не найден.");
    }
    route.tailFindText = String(findText || "");
    route.tailReplaceText = String(replaceText || "");
    route.updatedAt = new Date().toISOString();
    this.save();
    return route;
  }

  clearRouteRewrites(routeId) {
    const route = this.getRouteById(routeId);
    if (!route) {
      throw new Error("Маршрут не найден.");
    }
    route.findText = "";
    route.replaceText = "";
    route.tailFindText = "";
    route.tailReplaceText = "";
    route.updatedAt = new Date().toISOString();
    this.save();
    return route;
  }

  setRouteFilters(routeId, filters = {}) {
    const route = this.getRouteById(routeId);
    if (!route) {
      throw new Error("Маршрут не найден.");
    }
    route.includeKeywords = Array.isArray(filters.includeKeywords)
      ? [...new Set(filters.includeKeywords)]
      : route.includeKeywords || [];
    route.excludeKeywords = Array.isArray(filters.excludeKeywords)
      ? [...new Set(filters.excludeKeywords)]
      : route.excludeKeywords || [];
    route.updatedAt = new Date().toISOString();
    this.save();
    return route;
  }
}
