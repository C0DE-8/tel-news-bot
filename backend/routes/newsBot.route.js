const db = require("../db");
const { getPathname, sendJson } = require("../utils/http");

const GROUPS_STORE = "groups";
const POSTED_STORE = "posted";
const CHATS_STORE = "chats";
const MANUAL_POST_COOLDOWN_MS = 10 * 1000;
const INVESTMENT_SITE_URL = "https://zephyrequi.com";
const INVESTMENT_CODE_REGEX = /\bLF-IPC-(CIVIC|STEWAR|SELECT|DISTIN)-[A-Z0-9]{4}[A-F0-9]{6}\b/i;
const TELEGRAM_ALLOWED_UPDATES = ["message", "channel_post", "callback_query", "my_chat_member"];
const STORAGE_VERSION = "sql-normalized-v5-request-driven-scheduler";
let dataStoreReady = false;
let dataStorePromise = null;
let duePostPromise = null;

const NEWS_TOPICS = {
  crypto: [
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
  ],
  politics: [
    "https://feeds.bbci.co.uk/news/politics/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
  ],
};

function createNewsBotRoute({ token, defaultIntervalMinutes, useWebhook, adminChatIds, groupChatIds, requireHttpAdmin }) {
  const bot = new NewsBot({
    token,
    defaultIntervalMinutes,
    useWebhook,
    adminChatIds,
    groupChatIds,
  });

  return {
    bot,
    start: () => bot.start(),
    handle: (req, res) => handleRoute(req, res, bot, requireHttpAdmin || (() => {})),
  };
}

async function handleRoute(req, res, bot, requireHttpAdmin) {
  const pathname = getPathname(req);

  try {
    if (req.method === "GET" && pathname === "/bot/status") {
      requireHttpAdmin(req);
      sendJson(res, 200, await bot.getStatus());
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Route not found",
      routes: ["GET /bot/status"],
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message,
    });
  }
}

class NewsBot {
  constructor({ token, defaultIntervalMinutes, useWebhook, adminChatIds, groupChatIds }) {
    this.token = token;
    this.defaultIntervalMinutes = defaultIntervalMinutes;
    this.useWebhook = Boolean(useWebhook);
    this.adminChatIds = parseAdminChatIds(adminChatIds);
    this.configuredGroups = parseConfiguredGroups(groupChatIds);
    this.offset = 0;
    this.started = false;
    this.groupTimers = new Map();
    this.botUser = null;
    this.adminSelections = new Map();
  }

  start() {
    if (this.started) return;
    this.started = true;

    if (!this.token) {
      console.error("Missing TELEGRAM_BOT_TOKEN. Add it to backend/.env.");
      return;
    }

    this.initializeStorageAndRuntime().catch((error) => {
      console.error("Failed initializing news bot storage:", error.message);
    });
  }

  async initializeStorageAndRuntime() {
    await ensureDataStore();
    await this.seedConfiguredGroups();
    await this.restoreScheduledPosts();

    if (this.useWebhook) {
      console.log("Telegram webhook mode enabled.");
      return;
    }

    this.startTelegramPolling();
  }

  async getStatus() {
    const duePosts = await this.processDuePosts({ source: "bot-status" });
    const groups = await readJson(GROUPS_STORE);
    const activeGroups = Object.values(groups).filter((group) => group.enabled).length;
    const now = new Date();

    return {
      ok: true,
      running: this.started && Boolean(this.token),
      mode: this.useWebhook ? "webhook" : "polling",
      activeGroups,
      topics: Object.keys(NEWS_TOPICS),
      adminRestricted: this.adminChatIds.size > 0,
      scheduler: "request-driven-timer",
      duePosts,
      storage: {
        version: STORAGE_VERSION,
        type: "sql",
        tables: ["tel_news_groups", "tel_news_chats", "tel_news_posted"],
        legacyFileStore: false,
      },
      schedules: Object.fromEntries(
        Object.entries(groups).map(([chatId, group]) => [chatId, getScheduleStatus(group, now)])
      ),
    };
  }

  async listGroupConfigs() {
    await this.processDuePosts({ source: "list-configs" });
    return addScheduleStatuses(await readJson(GROUPS_STORE));
  }

  async listKnownGroups(options = {}) {
    await this.seedConfiguredGroups();
    const chats = await readJson(CHATS_STORE);
    const learnedGroups = Object.values(chats).filter((chat) => isGroupChatType(chat.type));
    const configs = await readJson(GROUPS_STORE);
    let groups = learnedGroups.map((group) => ({
      ...group,
      configured: Boolean(configs[group.id]),
      newsEnabled: Boolean(configs[group.id]?.enabled),
      topic: configs[group.id]?.topic || null,
    }));

    if (options.checkAccess) {
      groups = await Promise.all(
        groups.map(async (group) => {
          try {
            const result = await this.checkGroupAccess(group.id);
            return {
              ...group,
              title: result.chat.title || result.chat.username || group.title,
              type: result.chat.type || group.type,
              username: result.chat.username || group.username,
              botStatus: result.membership.status,
              canPost: result.canPost,
              accessError: null,
            };
          } catch (error) {
            return {
              ...group,
              botStatus: null,
              canPost: false,
              accessError: error.message,
            };
          }
        })
      );
    }

    return groups.sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
  }

  async seedConfiguredGroups() {
    if (!this.configuredGroups.length) return [];

    const chats = await readJson(CHATS_STORE);
    let changed = false;
    const now = new Date().toISOString();

    for (const group of this.configuredGroups) {
      const current = chats[group.id] || {};
      chats[group.id] = {
        id: group.id,
        title: current.title || group.title || group.id,
        type: current.type || group.type || inferChatType(group.id),
        username: current.username || group.username || null,
        updatedAt: current.updatedAt || now,
        source: current.source || "env",
      };
      changed = true;
    }

    if (changed) await writeJson(CHATS_STORE, chats);
    return this.configuredGroups;
  }

  async addKnownGroup(payload = {}) {
    const chatId = String(payload.chatId || "").trim();
    if (!chatId) throwHttpError(400, "chatId is required");

    if (payload.verify !== false) {
      const result = await this.checkGroupAccess(chatId);
      return {
        chat: await this.getKnownChat(chatId),
        access: {
          botStatus: result.membership.status,
          canPost: result.canPost,
        },
      };
    }

    const chats = await readJson(CHATS_STORE);
    chats[chatId] = {
      id: chatId,
      title: String(payload.title || chatId).trim(),
      type: String(payload.type || inferChatType(chatId)).trim(),
      username: payload.username || null,
      updatedAt: new Date().toISOString(),
      source: "manual",
    };
    await writeJson(CHATS_STORE, chats);

    return {
      chat: chats[chatId],
      access: null,
    };
  }

  async refreshKnownGroups() {
    await this.seedConfiguredGroups();
    return this.listKnownGroups({ checkAccess: true });
  }

  async getKnownChat(chatId) {
    const chats = await readJson(CHATS_STORE);
    return chats[String(chatId)] || null;
  }

  async getGroupConfig(chatId) {
    const group = (await readJson(GROUPS_STORE))[String(chatId)] || null;
    return group ? addScheduleStatus(group) : null;
  }

  async configureGroup(payload) {
    const chatId = String(payload.chatId || "").trim();
    const topic = String(payload.topic || "").toLowerCase();
    const intervalMinutes = Number(payload.intervalMinutes || this.defaultIntervalMinutes);
    const postLimit = normalizePostLimit(payload.postLimit);
    const postAt = normalizePostAt(payload.postAt);
    const enabled = payload.enabled !== false;

    if (!chatId) throwHttpError(400, "chatId is required");
    if (!NEWS_TOPICS[topic]) throwHttpError(400, "topic must be crypto or politics");
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
      throwHttpError(400, "intervalMinutes must be a whole number from 5 to 1440");
    }

    const groups = await readJson(GROUPS_STORE);
    const current = groups[chatId] || {};

    const nextGroup = {
      topic,
      intervalMinutes,
      postLimit,
      postAt,
      postsSent: payload.resetCount === false ? current.postsSent || 0 : 0,
      enabled,
      lastManualPostAt: current.lastManualPostAt || null,
      lastScheduledPostAt: current.lastScheduledPostAt || null,
      lastScheduledAttemptAt: current.lastScheduledAttemptAt || null,
      updatedAt: new Date().toISOString(),
    };
    groups[chatId] = nextGroup;
    await writeJson(GROUPS_STORE, groups);
    const savedGroup = await this.requireSavedGroup(chatId, nextGroup);

    if (enabled) {
      this.scheduleGroup(chatId, savedGroup);
    } else {
      this.clearGroupTimer(chatId);
    }

    if (payload.postNow === true && enabled) {
      await this.postNewsNow(chatId, { manual: true });
    }

    await this.sendAdminUpdate(
      [
        "✅ Database saved first.",
        `💬 Chat: ${chatId}`,
        `📰 Topic: ${savedGroup.topic}`,
        `⏱ Every: ${savedGroup.intervalMinutes} minutes`,
        `🔢 Limit: ${savedGroup.postLimit || "none"}`,
        "Scheduler: saved timer",
      ].join("\n"),
      { replyMarkup: adminKeyboard(chatId) }
    );

    return addScheduleStatus(savedGroup);
  }

  async requireSavedGroup(chatId, expectedGroup) {
    const savedGroup = (await readJson(GROUPS_STORE))[chatId];
    if (!savedGroup) throw new Error(`Database save failed for ${chatId}: row was not found after write`);

    const checks = [
      ["topic", savedGroup.topic, expectedGroup.topic],
      ["intervalMinutes", Number(savedGroup.intervalMinutes), Number(expectedGroup.intervalMinutes)],
      ["postLimit", savedGroup.postLimit ?? null, expectedGroup.postLimit ?? null],
      ["enabled", Boolean(savedGroup.enabled), Boolean(expectedGroup.enabled)],
    ];

    for (const [field, saved, expected] of checks) {
      if (saved !== expected) {
        throw new Error(`Database save failed for ${chatId}: ${field} saved as ${saved}, expected ${expected}`);
      }
    }

    return savedGroup;
  }

  async configureGroups(payload) {
    const chatIds = normalizeChatIds(payload.chatIds || payload.chatId);
    if (chatIds.length <= 1) {
      return this.configureGroup({ ...payload, chatId: chatIds[0] });
    }

    const groups = {};
    for (const chatId of chatIds) {
      groups[chatId] = await this.configureGroup({ ...payload, chatId });
    }

    return { groups };
  }

  async disableGroup(chatId) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throwHttpError(400, "chatId is required");

    const groups = await readJson(GROUPS_STORE);
    const current = groups[normalizedChatId] || {};
    groups[normalizedChatId] = {
      ...current,
      enabled: false,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(GROUPS_STORE, groups);
    this.clearGroupTimer(normalizedChatId);

    return addScheduleStatus(groups[normalizedChatId]);
  }

  async enableGroup(chatId) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throwHttpError(400, "chatId is required");

    const groups = await readJson(GROUPS_STORE);
    const current = groups[normalizedChatId];
    if (!current?.topic || !NEWS_TOPICS[current.topic]) {
      throwHttpError(404, "No saved news config found. Set news for this chat first.");
    }

    groups[normalizedChatId] = {
      ...current,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(GROUPS_STORE, groups);
    this.scheduleGroup(normalizedChatId, groups[normalizedChatId]);

    return addScheduleStatus(groups[normalizedChatId]);
  }

  async handleTelegramUpdate(update) {
    await this.processDuePosts({ source: "telegram-update" });

    if (update.message) {
      await this.rememberChat(update.message.chat);
      if (update.message.text) await this.handleMessage(update.message);
      return;
    }

    if (update.channel_post) {
      await this.rememberChat(update.channel_post.chat);
      if (update.channel_post.text) await this.handleMessage(update.channel_post);
      return;
    }

    if (update.callback_query) {
      await this.rememberChat(update.callback_query.message?.chat);
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    if (update.my_chat_member) {
      await this.rememberChat(update.my_chat_member.chat);
    }
  }

  async rememberChat(chat) {
    if (!chat?.id || !isGroupChatType(chat.type)) return;

    const chats = await readJson(CHATS_STORE);
    const chatId = String(chat.id);
    chats[chatId] = {
      id: chatId,
      title: chat.title || chat.username || chat.first_name || chatId,
      type: chat.type,
      username: chat.username || null,
      updatedAt: new Date().toISOString(),
      source: chats[chatId]?.source || "telegram",
    };
    await writeJson(CHATS_STORE, chats);
  }

  startTelegramPolling() {
    console.log("Telegram polling started.");
    this.pollTelegram().catch((error) => {
      console.error("Telegram polling crashed:", error);
      setTimeout(() => this.startTelegramPolling(), 5000);
    });
  }

  async pollTelegram() {
    while (true) {
      try {
        const updates = await this.telegram("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        });

        for (const update of updates.result || []) {
          this.offset = update.update_id + 1;
          await this.handleTelegramUpdate(update);
        }
      } catch (error) {
        console.error("Polling error:", error.message);
        await sleep(3000);
      }
    }
  }

  async handleMessage(message) {
    const chatId = String(message.chat.id);
    const userId = String(message.from?.id || "");
    const text = message.text.trim();

    if (await this.handleInvestmentCodeMessage(message, text)) return;

    const [commandWithBotName, ...args] = text.split(/\s+/);
    const arg = args[0];
    const command = commandWithBotName.split("@")[0].toLowerCase();

    if (!command.startsWith("/")) return;

    if (isGroupChatType(message.chat.type)) {
      await this.sendAdminUpdate(`Ignored group command ${command} in ${chatLabel(message.chat)}. Manage the bot from your private admin chat.`);
      return;
    }

    if (command === "/start" || command === "/help") {
      await this.sendMainMenu(chatId);
      return;
    }

    if (command === "/adminhelp" || command === "/adminpanel") {
      if (!(await this.requireAdmin(message))) return;
      await this.sendAdminHelp(chatId, true);
      return;
    }

    if (command === "/adminid") {
      await this.sendMessage(chatId, `Your admin id: ${userId || "unknown"}\nThis chat id: ${chatId}`);
      return;
    }

    if (command === "/adminset") {
      if (!(await this.requireAdmin(message))) return;
      await this.handleAdminSet(chatId, args);
      return;
    }

    if (command === "/adminstop") {
      if (!(await this.requireAdmin(message))) return;
      await this.handleAdminStop(chatId, args);
      return;
    }

    if (command === "/adminlist") {
      if (!(await this.requireAdmin(message))) return;
      await this.handleAdminList(chatId);
      return;
    }

    if (command === "/adminstatus") {
      if (!(await this.requireAdmin(message))) return;
      await this.handleAdminStatus(chatId, args);
      return;
    }

    if (command === "/admincheck") {
      if (!(await this.requireAdmin(message))) return;
      await this.handleAdminCheck(chatId, args);
      return;
    }

    if (command === "/admintest") {
      if (!(await this.requireAdmin(message))) return;
      await this.sendTestMessage(normalizeTargetChatId(args[0], chatId));
      return;
    }

    if (command === "/setnews") {
      if (!(await this.requireAdmin(message))) return;
      await this.setNewsTopic(chatId, arg);
      return;
    }

    if (command === "/news") {
      if (!(await this.requireAdmin(message))) return;
      const result = await this.postNewsNow(chatId, { manual: true });
      if (result?.cooldownRemainingMs) {
        await this.sendMessage(chatId, `Please wait ${Math.ceil(result.cooldownRemainingMs / 1000)} seconds before posting news again.`);
      }
      return;
    }

    if (command === "/status") {
      await this.sendChatStatus(chatId);
      return;
    }

    if (command === "/setinterval") {
      if (!(await this.requireAdmin(message))) return;
      await this.setIntervalMinutes(chatId, arg);
      return;
    }

    if (command === "/stopnews") {
      if (!(await this.requireAdmin(message))) return;
      await this.stopNews(chatId);
    }
  }

  async handleInvestmentCodeMessage(message, text) {
    if (!INVESTMENT_CODE_REGEX.test(text)) return false;

    await this.sendMessage(String(message.chat.id), `${INVESTMENT_SITE_URL} is the investment site.`);
    return true;
  }

  async handleCallbackQuery(callbackQuery) {
    const message = callbackQuery.message;
    const chatId = String(message?.chat?.id || "");
    const data = String(callbackQuery.data || "");

    if (!chatId || (!data.startsWith("admin:") && !data.startsWith("bot:"))) {
      await this.answerCallbackQuery(callbackQuery.id, "Unknown action.");
      return;
    }

    if (isGroupChatType(message?.chat?.type)) {
      await this.answerCallbackQuery(callbackQuery.id, "Use the private bot chat.");
      await this.sendAdminUpdate(`Ignored group button click in ${chatLabel(message.chat)}. Controls only work in the private admin chat.`);
      return;
    }

    if (data.startsWith("bot:")) {
      await this.handleBotCallback(callbackQuery, chatId, data);
      return;
    }

    if (!(await this.requireAdmin({ from: callbackQuery.from, chat: message.chat }))) {
      await this.answerCallbackQuery(callbackQuery.id, "Admin only.");
      return;
    }

    const [, action, target = "this", topic, intervalMinutes, postLimit] = data.split(":");
    const targetChatId = normalizeTargetChatId(target, chatId);

    try {
      if (action === "panel") {
        await this.sendAdminPanel(chatId);
        await this.answerCallbackQuery(callbackQuery.id, "Panel opened.");
        return;
      }

      if (action === "main") {
        await this.sendMainMenu(chatId);
        await this.answerCallbackQuery(callbackQuery.id, "Main menu opened.");
        return;
      }

      if (action === "groups") {
        await this.sendGroupPicker(chatId);
        await this.answerCallbackQuery(callbackQuery.id, "Pick chat.");
        return;
      }

      if (action === "multi") {
        await this.sendMultiPicker(chatId, callbackQuery.from?.id);
        await this.answerCallbackQuery(callbackQuery.id, "Select chats.");
        return;
      }

      if (action === "toggle") {
        this.toggleAdminSelection(callbackQuery.from?.id, targetChatId);
        await this.sendMultiPicker(chatId, callbackQuery.from?.id);
        await this.answerCallbackQuery(callbackQuery.id, "Selection updated.");
        return;
      }

      if (action === "clear") {
        this.clearAdminSelection(callbackQuery.from?.id);
        await this.sendMultiPicker(chatId, callbackQuery.from?.id);
        await this.answerCallbackQuery(callbackQuery.id, "Selection cleared.");
        return;
      }

      if (action === "selected") {
        const selectedIds = this.getAdminSelection(callbackQuery.from?.id);
        if (!selectedIds.length) {
          await this.sendMultiPicker(chatId, callbackQuery.from?.id);
          await this.answerCallbackQuery(callbackQuery.id, "Pick at least one chat.");
          return;
        }

        await this.sendMessage(chatId, `✅ Selected ${selectedIds.length} chats\n\n📰 Pick the news topic to apply to all selected chats.`, {
          replyMarkup: topicKeyboard("selected"),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Choose topic.");
        return;
      }

      if (action === "group") {
        const group = (await this.listKnownGroups()).find((knownGroup) => knownGroup.id === targetChatId);
        await this.sendMessage(chatId, `Managing ${formatChatLabel(group || { id: targetChatId })}`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Chat selected.");
        return;
      }

      if (action === "id") {
        await this.sendMessage(chatId, `Your admin id: ${callbackQuery.from?.id || "unknown"}\nThis chat id: ${chatId}`, {
          replyMarkup: adminHomeKeyboard(chatId, await this.listKnownGroups()),
        });
        await this.answerCallbackQuery(callbackQuery.id, "ID sent.");
        return;
      }

      if (action === "configure") {
        await this.sendMessage(chatId, "📰 Pick the news topic for this chat.", {
          replyMarkup: topicKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Choose topic.");
        return;
      }

      if (action === "topic") {
        await this.sendMessage(chatId, `📰 Topic selected: ${topic}\n\n⏱ Pick how often to post.`, {
          replyMarkup: intervalKeyboard(targetChatId, topic),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Choose interval.");
        return;
      }

      if (action === "interval") {
        await this.sendMessage(chatId, `⏱ Interval selected: ${intervalMinutes} minutes\n\n🔢 Pick how many posts to send.`, {
          replyMarkup: limitKeyboard(targetChatId, topic, intervalMinutes),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Choose limit.");
        return;
      }

      if (action === "set") {
        if (target === "selected") {
          const selectedIds = this.getAdminSelection(callbackQuery.from?.id);
          if (!selectedIds.length) {
            await this.sendMultiPicker(chatId, callbackQuery.from?.id);
            await this.answerCallbackQuery(callbackQuery.id, "Pick at least one chat.");
            return;
          }

          const result = await this.configureGroups({
            chatIds: selectedIds,
            topic,
            intervalMinutes,
            postLimit,
          });
          await this.sendMessage(chatId, formatMultiConfigResult(result.groups), {
            replyMarkup: adminHomeKeyboard(chatId, await this.listKnownGroups()),
          });
          await this.answerCallbackQuery(callbackQuery.id, "Saved.");
          return;
        }

        const group = await this.configureGroup({
          chatId: targetChatId,
          topic,
          intervalMinutes,
          postLimit,
        });
        await this.sendMessage(chatId, `✅ Saved to SQL database\n\n${formatGroupConfig(targetChatId, group)}`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Saved.");
        return;
      }

      if (action === "status") {
        const group = await this.getGroupConfig(targetChatId);
        await this.sendMessage(chatId, group ? formatGroupConfig(targetChatId, group) : `No config found for ${targetChatId}.`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Status sent.");
        return;
      }

      if (action === "timer") {
        const duePosts = await this.processDuePosts({ source: "timer-button" });
        const group = await this.getGroupConfig(targetChatId);
        await this.sendMessage(chatId, group ? formatTimerStatus(targetChatId, group, duePosts) : `No config found for ${targetChatId}.`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Timer status sent.");
        return;
      }

      if (action === "check") {
        const result = await this.checkGroupAccess(targetChatId);
        await this.sendMessage(chatId, formatGroupAccess(result), {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Chat checked.");
        return;
      }

      if (action === "test") {
        await this.sendTestMessage(targetChatId);
        await this.answerCallbackQuery(callbackQuery.id, "Test sent.");
        return;
      }

      if (action === "post") {
        const result = await this.postNewsNow(targetChatId, { manual: true });
        if (result?.cooldownRemainingMs) {
          const seconds = Math.ceil(result.cooldownRemainingMs / 1000);
          await this.sendMessage(chatId, `Please wait ${seconds} seconds before posting news again.`, {
            replyMarkup: adminKeyboard(targetChatId),
          });
          await this.answerCallbackQuery(callbackQuery.id, `Wait ${seconds}s.`);
          return;
        }

        await this.answerCallbackQuery(callbackQuery.id, "Post requested.");
        return;
      }

      if (action === "stop") {
        await this.disableGroup(targetChatId);
        await this.sendMessage(chatId, `⏸ News stopped for ${targetChatId}.`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Stopped.");
        return;
      }

      if (action === "start") {
        const group = await this.enableGroup(targetChatId);
        await this.sendMessage(chatId, `▶️ News started for ${targetChatId}\n\n${formatGroupConfig(targetChatId, group)}`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Started.");
        return;
      }

      if (action === "list") {
        await this.handleAdminList(chatId);
        await this.answerCallbackQuery(callbackQuery.id, "List sent.");
        return;
      }

      await this.answerCallbackQuery(callbackQuery.id, "Unknown action.");
    } catch (error) {
      await this.sendMessage(chatId, `Button action failed: ${error.message}`, {
        replyMarkup: adminKeyboard(targetChatId),
      });
      await this.answerCallbackQuery(callbackQuery.id, "Action failed.");
    }
  }

  async handleBotCallback(callbackQuery, chatId, data) {
    const [, action, target = "this"] = data.split(":");
    const targetChatId = normalizeTargetChatId(target, chatId);

    if (action === "menu") {
      await this.sendMainMenu(chatId);
      await this.answerCallbackQuery(callbackQuery.id, "Menu opened.");
      return;
    }

    if (action === "status") {
      if (!isLikelyGroupChatId(targetChatId)) {
        await this.sendGroupPicker(chatId);
        await this.answerCallbackQuery(callbackQuery.id, "Pick chat.");
        return;
      }

      await this.sendChatStatus(chatId, targetChatId);
      await this.answerCallbackQuery(callbackQuery.id, "Status sent.");
      return;
    }

    if (action === "news") {
      if (!(await this.requireAdmin({ from: callbackQuery.from, chat: callbackQuery.message.chat }))) {
        await this.answerCallbackQuery(callbackQuery.id, "Admin only.");
        return;
      }

      if (!isLikelyGroupChatId(targetChatId)) {
        await this.sendGroupPicker(chatId);
        await this.answerCallbackQuery(callbackQuery.id, "Pick chat.");
        return;
      }

      const result = await this.postNewsNow(targetChatId, { manual: true });
      if (result?.cooldownRemainingMs) {
        const seconds = Math.ceil(result.cooldownRemainingMs / 1000);
        await this.sendMessage(chatId, `Please wait ${seconds} seconds before posting news again.`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, `Wait ${seconds}s.`);
        return;
      }
      await this.answerCallbackQuery(callbackQuery.id, "Post requested.");
      return;
    }

    if (action === "admin") {
      if (!(await this.requireAdmin({ from: callbackQuery.from, chat: callbackQuery.message.chat }))) {
        await this.answerCallbackQuery(callbackQuery.id, "Admin only.");
        return;
      }

      await this.sendAdminPanel(chatId);
      await this.answerCallbackQuery(callbackQuery.id, "Admin panel opened.");
      return;
    }

    if (action === "id") {
      await this.sendMessage(chatId, `Your admin id: ${callbackQuery.from?.id || "unknown"}\nThis chat id: ${chatId}`, {
        replyMarkup: mainMenuKeyboard(chatId),
      });
      await this.answerCallbackQuery(callbackQuery.id, "ID sent.");
      return;
    }

    await this.answerCallbackQuery(callbackQuery.id, "Unknown action.");
  }

  async requireAdmin(message) {
    if (this.adminChatIds.size === 0) return true;

    const userId = String(message.from?.id || "");
    if (this.adminChatIds.has(userId)) return true;

    await this.sendMessage(String(message.chat.id), "Only a configured admin can manage this bot.");
    return false;
  }

  getAdminNotificationChatId() {
    return [...this.adminChatIds][0] || null;
  }

  async sendAdminUpdate(text, options) {
    const adminChatId = this.getAdminNotificationChatId();
    if (!adminChatId) return;

    try {
      await this.sendMessage(adminChatId, text, options);
    } catch (error) {
      console.error("Failed sending admin update:", error.message);
    }
  }

  async sendAdminHelp(chatId, includeButtons = false) {
    const knownGroups = await this.listKnownGroups();
    const text = knownGroups.length
      ? "🛠 Admin panel\n\nPick one chat, or use Select multiple to update several chats at once."
      : "🛠 Admin panel\n\nNo known chats yet. Add the bot to a channel/group or set TELEGRAM_GROUP_CHAT_IDS, then open this panel again.";

    await this.sendMessage(
      chatId,
      text,
      includeButtons ? { replyMarkup: adminHomeKeyboard(chatId, knownGroups) } : undefined
    );
  }

  async sendMainMenu(chatId) {
    await this.sendMessage(chatId, "🏠 Main menu\n\nChoose what you want to manage.", {
      replyMarkup: mainMenuKeyboard(chatId),
    });
  }

  async sendAdminPanel(chatId) {
    const knownGroups = await this.listKnownGroups();
    await this.sendMessage(chatId, "🛠 Admin panel\n\nPick one chat, or select multiple chats for a bulk update.", {
      replyMarkup: adminHomeKeyboard(chatId, knownGroups),
    });
  }

  async sendGroupPicker(chatId) {
    const knownGroups = await this.listKnownGroups();
    await this.sendMessage(chatId, knownGroups.length ? "💬 Pick a chat to manage." : "No known chats yet.", {
      replyMarkup: groupPickerKeyboard(chatId, knownGroups),
    });
  }

  async sendMultiPicker(chatId, adminUserId) {
    const knownGroups = await this.listKnownGroups();
    const selectedIds = this.getAdminSelection(adminUserId);
    await this.sendMessage(
      chatId,
      knownGroups.length
        ? `✅ Select chats to configure\n\nSelected: ${selectedIds.length}\nTap a chat to add/remove it, then tap Set news for selected.`
        : "No known chats yet. Add the bot to channels/groups or set TELEGRAM_GROUP_CHAT_IDS.",
      {
        replyMarkup: multiPickerKeyboard(knownGroups, selectedIds),
      }
    );
  }

  getAdminSelection(adminUserId) {
    const key = String(adminUserId || "");
    return [...(this.adminSelections.get(key) || new Set())];
  }

  toggleAdminSelection(adminUserId, chatId) {
    const key = String(adminUserId || "");
    const selected = this.adminSelections.get(key) || new Set();
    if (selected.has(chatId)) {
      selected.delete(chatId);
    } else {
      selected.add(chatId);
    }
    this.adminSelections.set(key, selected);
  }

  clearAdminSelection(adminUserId) {
    this.adminSelections.delete(String(adminUserId || ""));
  }

  async handleAdminSet(currentChatId, args) {
    const targetChatId = normalizeTargetChatId(args[0], currentChatId);
    const topic = args[1];
    const intervalMinutes = args[2];
    const postLimit = args[3];
    const fifthArg = args[4];
    const postNow = fifthArg === "now" || args.includes("--now");
    const postAt = postNow ? null : fifthArg;

    try {
      const group = await this.configureGroup({
        chatId: targetChatId,
        topic,
        intervalMinutes,
        postLimit,
        postAt,
        postNow,
      });

      await this.sendMessage(
        currentChatId,
        [
          `Saved config for ${targetChatId}.`,
          `Topic: ${group.topic}`,
          `Every: ${group.intervalMinutes} minutes`,
          `Limit: ${group.postLimit || "none"}`,
          `Start: ${group.postAt || "now"}`,
          `Posts sent: ${group.postsSent || 0}`,
        ].join("\n")
      );
    } catch (error) {
      await this.sendMessage(currentChatId, `Admin config failed: ${error.message}\nUse /adminhelp for examples.`);
    }
  }

  async handleAdminStop(currentChatId, args) {
    const targetChatId = normalizeTargetChatId(args[0], currentChatId);

    try {
      await this.disableGroup(targetChatId);
      await this.sendMessage(currentChatId, `News stopped for ${targetChatId}.`);
    } catch (error) {
      await this.sendMessage(currentChatId, `Stop failed: ${error.message}`);
    }
  }

  async handleAdminStatus(currentChatId, args) {
    const targetChatId = normalizeTargetChatId(args[0], currentChatId);
    const group = await this.getGroupConfig(targetChatId);

    if (!group) {
      await this.sendMessage(currentChatId, `No config found for ${targetChatId}.`);
      return;
    }

    await this.sendMessage(currentChatId, formatGroupConfig(targetChatId, group));
  }

  async handleAdminCheck(currentChatId, args) {
    const targetChatId = normalizeTargetChatId(args[0], currentChatId);

    try {
      const result = await this.checkGroupAccess(targetChatId);
      await this.sendMessage(currentChatId, formatGroupAccess(result), {
        replyMarkup: adminKeyboard(targetChatId),
      });
    } catch (error) {
      await this.sendMessage(currentChatId, `Chat check failed: ${error.message}`);
    }
  }

  async handleAdminList(chatId) {
    const groups = await this.listGroupConfigs();
    const lines = Object.entries(groups).map(([groupChatId, group]) => formatGroupConfig(groupChatId, group));

    await this.sendMessage(chatId, lines.length ? lines.join("\n\n") : "No chat configs saved yet.", {
      replyMarkup: adminHomeKeyboard(chatId, await this.listKnownGroups()),
    });
  }

  async setNewsTopic(chatId, topic) {
    const normalizedTopic = String(topic || "").toLowerCase();
    if (!NEWS_TOPICS[normalizedTopic]) {
      await this.sendMessage(chatId, "Choose a valid topic from the admin panel.", {
        replyMarkup: adminKeyboard(chatId),
      });
      return;
    }

    const groups = await readJson(GROUPS_STORE);
    groups[chatId] = {
      topic: normalizedTopic,
      intervalMinutes: groups[chatId]?.intervalMinutes || this.defaultIntervalMinutes,
      postLimit: null,
      postAt: null,
      postsSent: 0,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(GROUPS_STORE, groups);

    this.scheduleGroup(chatId, groups[chatId]);
    await this.sendAdminUpdate(`News topic set for ${chatId}: ${normalizedTopic}.`);
    await this.postNewsNow(chatId, { manual: true });
  }

  async setIntervalMinutes(chatId, minutesValue) {
    const minutes = Number(minutesValue);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      await this.sendMessage(chatId, "Choose an interval from the admin panel.", {
        replyMarkup: adminKeyboard(chatId),
      });
      return;
    }

    const groups = await readJson(GROUPS_STORE);
    if (!groups[chatId]) {
      await this.sendMessage(chatId, "Set a topic first from the admin panel.", {
        replyMarkup: adminKeyboard(chatId),
      });
      return;
    }

    groups[chatId].intervalMinutes = minutes;
    groups[chatId].enabled = true;
    groups[chatId].updatedAt = new Date().toISOString();
    await writeJson(GROUPS_STORE, groups);

    this.scheduleGroup(chatId, groups[chatId]);
    await this.sendAdminUpdate(`Posting interval set for ${chatId}: ${minutes} minutes.`);
  }

  async sendChatStatus(outputChatId, targetChatId = outputChatId) {
    await this.processDuePosts({ source: "chat-status" });
    const groups = await readJson(GROUPS_STORE);
    const group = groups[targetChatId];

    if (!group || !group.enabled) {
      await this.sendMessage(outputChatId, `News posting is not active for ${targetChatId}. Open the admin panel and choose Set news.`, {
        replyMarkup: adminKeyboard(targetChatId),
      });
      return;
    }

    await this.sendMessage(outputChatId, formatGroupConfig(targetChatId, group), {
      replyMarkup: adminKeyboard(targetChatId),
    });
  }

  async checkGroupAccess(chatId) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throwHttpError(400, "chatId is required");

    const [chat, botUser] = await Promise.all([this.telegram("getChat", { chat_id: normalizedChatId }), this.getMe()]);
    await this.rememberChat(chat.result);
    const membership = await this.telegram("getChatMember", {
      chat_id: normalizedChatId,
      user_id: botUser.id,
    });

    return {
      chatId: normalizedChatId,
      chat: chat.result,
      bot: botUser,
      membership: membership.result,
      canPost: canBotPost(membership.result),
    };
  }

  async sendTestMessage(chatId, text) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throwHttpError(400, "chatId is required");

    const response = await this.sendMessage(
      normalizedChatId,
      text || `Test message from news bot.\nChat id: ${normalizedChatId}\nTime: ${new Date().toISOString()}`
    );

    return {
      chatId: normalizedChatId,
      message: response.result,
    };
  }

  async storageCheck() {
    await ensureDataStore();

    const checkId = `check_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const checkedAt = new Date().toISOString();
    await db.execute(
      "INSERT INTO tel_news_storage_checks (check_id, checked_at, note) VALUES (?, ?, ?)",
      [checkId, checkedAt, "admin storage check"]
    );

    const [check] = await db.query("SELECT check_id, checked_at, note FROM tel_news_storage_checks WHERE check_id = ? LIMIT 1", [checkId]);
    const counts = await getStorageCounts();

    return {
      ok: Boolean(check),
      storage: {
        version: STORAGE_VERSION,
        type: "sql",
        tables: ["tel_news_groups", "tel_news_chats", "tel_news_posted", "tel_news_storage_checks"],
      },
      wrote: check || null,
      counts,
    };
  }

  async stopNews(chatId) {
    const groups = await readJson(GROUPS_STORE);
    if (groups[chatId]) {
      groups[chatId].enabled = false;
      groups[chatId].updatedAt = new Date().toISOString();
      await writeJson(GROUPS_STORE, groups);
    }

    this.clearGroupTimer(chatId);
    await this.sendAdminUpdate(`News posting stopped for ${chatId}.`);
  }

  async restoreScheduledPosts() {
    const groups = await readJson(GROUPS_STORE);
    for (const [chatId, group] of Object.entries(groups)) {
      if (group.enabled) this.scheduleGroup(chatId, group);
    }
  }

  async processDuePosts(options = {}) {
    if (duePostPromise) return duePostPromise;

    duePostPromise = this.runDuePosts(options).finally(() => {
      duePostPromise = null;
    });

    return duePostPromise;
  }

  async runDuePosts(options = {}) {
    const now = options.now || new Date();
    const groups = await readJson(GROUPS_STORE);
    const dueEntries = Object.entries(groups).filter(([, group]) => getScheduleDueState(group, now).ready);

    if (!dueEntries.length) {
      return { checkedAt: now.toISOString(), source: options.source || "unknown", checked: Object.keys(groups).length, due: 0, posted: 0, errors: [] };
    }

    for (const [chatId, group] of dueEntries) {
      groups[chatId] = {
        ...group,
        lastScheduledAttemptAt: now.toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    await writeJson(GROUPS_STORE, groups);

    const results = [];
    for (const [chatId] of dueEntries) {
      try {
        const result = await this.postNewsNow(chatId, { scheduled: true, now, silentNoConfig: true });
        results.push({ chatId, posted: Boolean(result?.posted), article: result?.article?.title || null });
      } catch (error) {
        results.push({ chatId, posted: false, error: error.message });
        await this.sendAdminUpdate(`Scheduled post failed for ${chatId}: ${error.message}`, {
          replyMarkup: adminKeyboard(chatId),
        });
      }
    }

    return {
      checkedAt: now.toISOString(),
      source: options.source || "unknown",
      checked: Object.keys(groups).length,
      due: dueEntries.length,
      posted: results.filter((result) => result.posted).length,
      errors: results.filter((result) => result.error),
      results,
    };
  }

  scheduleGroup(chatId, group) {
    this.clearGroupTimer(chatId);

    const intervalMs = Math.max(5, group.intervalMinutes || this.defaultIntervalMinutes) * 60 * 1000;
    const startInterval = () => {
      const interval = setInterval(() => {
        this.postNewsNow(chatId).catch((error) => {
          console.error(`Failed posting news to ${chatId}:`, error.message);
        });
      }, intervalMs);

      this.groupTimers.set(chatId, { interval });
    };

    if (group.postAt) {
      const delayMs = Date.parse(group.postAt) - Date.now();
      if (delayMs > 0) {
        const timeout = setTimeout(() => {
          this.postNewsNow(chatId).catch((error) => {
            console.error(`Failed posting scheduled news to ${chatId}:`, error.message);
          });
          this.getGroupConfig(chatId)
            .then((current) => {
              if (current?.enabled) startInterval();
            })
            .catch((error) => {
              console.error(`Failed checking schedule state for ${chatId}:`, error.message);
            });
        }, delayMs);

        this.groupTimers.set(chatId, { timeout });
        return;
      }
    }

    startInterval();
  }

  clearGroupTimer(chatId) {
    const timer = this.groupTimers.get(chatId);
    if (timer?.interval) clearInterval(timer.interval);
    if (timer?.timeout) clearTimeout(timer.timeout);
    this.groupTimers.delete(chatId);
  }

  async postNewsNow(chatId, options = {}) {
    const normalizedChatId = String(chatId);
    const groups = await readJson(GROUPS_STORE);
    const group = groups[normalizedChatId];
    if (!group?.enabled || !NEWS_TOPICS[group.topic]) {
      if (!options.silentNoConfig) {
        await this.sendAdminUpdate(`No active news config found for ${normalizedChatId}.`, {
          replyMarkup: adminKeyboard(normalizedChatId),
        });
      }
      return;
    }

    if (hasReachedPostLimit(group)) {
      group.enabled = false;
      group.updatedAt = new Date().toISOString();
      groups[normalizedChatId] = group;
      await writeJson(GROUPS_STORE, groups);
      this.clearGroupTimer(normalizedChatId);
      await this.sendAdminUpdate(`Post limit reached. News stopped for ${normalizedChatId}.`);
      return;
    }

    if (options.manual) {
      const cooldownRemainingMs = getManualPostCooldownRemaining(group);
      if (cooldownRemainingMs > 0) {
        return { posted: false, cooldownRemainingMs };
      }
    }

    const article = await findFreshArticle(normalizedChatId, group.topic);
    if (!article) {
      await this.sendAdminUpdate(`No fresh ${group.topic} news found for ${normalizedChatId}. I will try again later.`);
      return;
    }

    await this.sendMessage(
      normalizedChatId,
      `<b>${escapeHtml(article.title)}</b>\n\n${escapeHtml(article.source)}\n${escapeHtml(article.link)}`,
      "HTML"
    );

    group.postsSent = Number(group.postsSent || 0) + 1;
    if (options.manual) group.lastManualPostAt = new Date().toISOString();
    if (options.scheduled) group.lastScheduledPostAt = (options.now || new Date()).toISOString();
    if (hasReachedPostLimit(group)) {
      group.enabled = false;
      this.clearGroupTimer(normalizedChatId);
    }
    group.updatedAt = new Date().toISOString();
    groups[normalizedChatId] = group;
    await writeJson(GROUPS_STORE, groups);

    await this.sendAdminUpdate(
      [
        `${options.scheduled ? "⏰ Scheduled" : options.manual ? "🚀 Manual" : "📰 News"} post sent from saved DB config.`,
        `💬 Chat: ${normalizedChatId}`,
        `📰 Topic: ${group.topic}`,
        `🔗 Title: ${article.title}`,
        group.enabled ? `📨 Posts sent: ${group.postsSent}` : "⏸ Post limit reached. News stopped.",
      ].join("\n"),
      { replyMarkup: adminKeyboard(normalizedChatId) }
    );

    return { posted: true, article };
  }

  async sendMessage(chatId, text, options) {
    const parseMode = typeof options === "string" ? options : options?.parseMode;
    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    };

    if (parseMode) payload.parse_mode = parseMode;
    if (options?.replyMarkup) payload.reply_markup = options.replyMarkup;
    return this.telegram("sendMessage", payload);
  }

  async answerCallbackQuery(callbackQueryId, text) {
    await this.telegram("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async getMe() {
    if (this.botUser) return this.botUser;

    const response = await this.telegram("getMe", {});
    this.botUser = response.result;
    return this.botUser;
  }

  async telegram(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`);
    }

    return data;
  }

  setWebhook(url, options = {}) {
    if (!url) throwHttpError(400, "url is required");

    return this.telegram("setWebhook", {
      url,
      allowed_updates: options.allowedUpdates || TELEGRAM_ALLOWED_UPDATES,
      drop_pending_updates: options.dropPendingUpdates === true,
    });
  }

  getWebhookInfo() {
    return this.telegram("getWebhookInfo", {});
  }

  deleteWebhook(dropPendingUpdates = false) {
    return this.telegram("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates === true,
    });
  }
}

function hasReachedPostLimit(group) {
  return Number.isInteger(group.postLimit) && Number(group.postsSent || 0) >= group.postLimit;
}

function getManualPostCooldownRemaining(group) {
  if (!group.lastManualPostAt) return 0;

  const elapsedMs = Date.now() - Date.parse(group.lastManualPostAt);
  if (!Number.isFinite(elapsedMs)) return 0;

  return Math.max(0, MANUAL_POST_COOLDOWN_MS - elapsedMs);
}

function getScheduleDueState(group, now) {
  const status = getScheduleStatus(group, now);
  if (!status.enabled) {
    return { ready: false, reason: status.reason };
  }

  if (status.due) {
    return { ready: true, reason: "due" };
  }

  return { ready: false, reason: status.reason };
}

function getScheduleStatus(group, now = new Date()) {
  if (!group) {
    return { enabled: false, due: false, reason: "missing_config" };
  }

  if (!group.enabled) {
    return { enabled: false, due: false, reason: "disabled" };
  }

  if (!NEWS_TOPICS[group.topic]) {
    return { enabled: false, due: false, reason: "missing_topic" };
  }

  const intervalMs = Math.max(5, group.intervalMinutes || 30) * 60 * 1000;
  const startTime = Date.parse(group.postAt || 0);
  const lastRunTime = latestTimestamp(group.lastScheduledPostAt, group.lastScheduledAttemptAt, group.updatedAt);
  let nextPostAtMs = lastRunTime + intervalMs;
  let reason = "interval_not_due";

  if (Number.isFinite(startTime) && startTime > now.getTime()) {
    nextPostAtMs = startTime;
    reason = "waiting_for_start_time";
  }

  if (!Number.isFinite(nextPostAtMs) || nextPostAtMs <= 0) {
    nextPostAtMs = now.getTime();
  }

  const nextPostInMs = Math.max(0, nextPostAtMs - now.getTime());

  return {
    enabled: true,
    due: nextPostInMs === 0,
    reason: nextPostInMs === 0 ? "due" : reason,
    intervalMinutes: Math.max(5, group.intervalMinutes || 30),
    nextPostAt: new Date(nextPostAtMs).toISOString(),
    nextPostInMs,
    nextPostInSeconds: Math.ceil(nextPostInMs / 1000),
    countdown: formatDuration(nextPostInMs),
    lastScheduledPostAt: group.lastScheduledPostAt || null,
    lastScheduledAttemptAt: group.lastScheduledAttemptAt || null,
    postsSent: Number(group.postsSent || 0),
    postLimit: group.postLimit || null,
    postsRemaining: Number.isInteger(group.postLimit)
      ? Math.max(0, group.postLimit - Number(group.postsSent || 0))
      : null,
  };
}

function addScheduleStatus(group, now = new Date()) {
  return {
    ...group,
    schedule: getScheduleStatus(group, now),
  };
}

function addScheduleStatuses(groups, now = new Date()) {
  return Object.fromEntries(
    Object.entries(groups).map(([chatId, group]) => [chatId, addScheduleStatus(group, now)])
  );
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

function formatScheduleLines(group, now = new Date()) {
  const status = group.schedule || getScheduleStatus(group, now);

  if (!status.enabled) {
    return [`Next post: not scheduled (${status.reason})`];
  }

  return [
    `Next post: ${status.due ? "due now" : status.countdown}`,
    `Next post at: ${status.nextPostAt}`,
    status.postLimit ? `Posts remaining: ${status.postsRemaining}` : null,
  ].filter(Boolean);
}

function latestTimestamp(...values) {
  const timestamps = values.map((value) => Date.parse(value || 0)).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

function normalizePostLimit(value) {
  if (value === undefined || value === null || value === "") return null;

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throwHttpError(400, "postLimit must be a whole number from 1 to 1000");
  }

  return limit;
}

function normalizePostAt(value) {
  if (!value) return null;

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throwHttpError(400, "postAt must be a valid date string");
  }

  return new Date(timestamp).toISOString();
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function parseAdminChatIds(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseConfiguredGroups(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [id, title] = item.split("|").map((part) => part.trim());
      return {
        id,
        title: title || id,
        type: inferChatType(id),
        username: null,
        updatedAt: null,
        source: "env",
      };
    });
}

function normalizeTargetChatId(value, currentChatId) {
  if (!value || value === "this") return currentChatId;
  return String(value).trim();
}

function normalizeChatIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isGroupChatType(type) {
  return ["group", "supergroup", "channel"].includes(type);
}

function inferChatType(chatId) {
  return String(chatId).startsWith("-100") ? "channel" : "group";
}

function isLikelyGroupChatId(chatId) {
  return String(chatId).startsWith("-");
}

function formatChatLabel(chat) {
  return `${chat.title || chat.username || chat.id} (${chat.id})`;
}

function chatLabel(chat) {
  if (!chat) return "unknown chat";
  return `${chat.title || chat.username || chat.first_name || chat.id} (${chat.id})`;
}

function formatGroupConfig(chatId, group) {
  return [
    `💬 Chat: ${chatId}`,
    `🔌 Enabled: ${group.enabled ? "yes" : "no"}`,
    `📰 Topic: ${group.topic || "not set"}`,
    `⏱ Every: ${group.intervalMinutes || "not set"} minutes`,
    `🔢 Limit: ${group.postLimit || "none"}`,
    `🚦 Start: ${group.postAt || "now"}`,
    `📨 Posts sent: ${group.postsSent || 0}`,
    ...formatScheduleLines(group),
  ].join("\n");
}

function formatMultiConfigResult(groups) {
  const entries = Object.entries(groups || {});
  return [
    `✅ Saved news config for ${entries.length} chats.`,
    ...entries.map(([chatId, group]) => `• ${chatId}: ${group.topic}, every ${group.intervalMinutes} minutes, limit ${group.postLimit || "none"}`),
  ].join("\n");
}

function formatTimerStatus(chatId, group, duePosts) {
  const status = group.schedule || getScheduleStatus(group);
  const result = duePosts?.results?.find((item) => item.chatId === String(chatId));

  return [
    `⏳ Timer status for ${chatId}`,
    duePosts ? `🔎 Due check: ${duePosts.posted}/${duePosts.due} posted` : null,
    result?.error ? `⚠️ Last due error: ${result.error}` : null,
    result?.posted ? `✅ Due post sent: ${result.article || "news posted"}` : null,
    `🔌 Enabled: ${status.enabled ? "yes" : "no"}`,
    `🚦 Due: ${status.due ? "yes" : "no"}`,
    `ℹ️ Reason: ${status.reason}`,
    `⏱ Interval: ${status.intervalMinutes || group.intervalMinutes || "not set"} minutes`,
    status.enabled ? `⏭ Next post: ${status.due ? "due now" : status.countdown}` : null,
    status.enabled ? `🗓 Next post at: ${status.nextPostAt}` : null,
    `📨 Posts sent: ${status.postsSent ?? Number(group.postsSent || 0)}`,
    status.postLimit ? `🔢 Post limit: ${status.postLimit}` : "🔢 Post limit: none",
    status.postLimit ? `📌 Posts remaining: ${status.postsRemaining}` : null,
    `🕘 Last post: ${status.lastScheduledPostAt || "none"}`,
    `🔁 Last timer attempt: ${status.lastScheduledAttemptAt || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatGroupAccess(result) {
  const chatTitle = result.chat.title || result.chat.username || result.chat.id;
  const member = result.membership;

  return [
    `Chat check for ${chatTitle}`,
    `Chat id: ${result.chatId}`,
    `Bot: @${result.bot.username || result.bot.first_name}`,
    `Bot status: ${member.status}`,
    `Can post: ${result.canPost ? "yes" : "no"}`,
    member.can_send_messages === false ? "Reason: can_send_messages is false" : null,
    member.can_post_messages === false ? "Reason: can_post_messages is false" : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function canBotPost(member) {
  if (!member || member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.can_send_messages !== false;
  if (member.can_post_messages === false) return false;
  return ["creator", "administrator", "member"].includes(member.status);
}

function mainMenuKeyboard(currentChatId) {
  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: `bot:status:${currentChatId}` },
        { text: "🚀 Send now", callback_data: `bot:news:${currentChatId}` },
      ],
      [
        { text: "🛠 Admin panel", callback_data: `bot:admin:${currentChatId}` },
        { text: "🪪 Admin ID", callback_data: "bot:id:this" },
      ],
    ],
  };
}

function adminHomeKeyboard(currentChatId, knownGroups) {
  const rows = [];

  if (knownGroups.length) {
    rows.push([{ text: "💬 Pick one chat", callback_data: "admin:groups:this" }]);
    rows.push([{ text: "✅ Select multiple chats", callback_data: "admin:multi:this" }]);
    for (const group of knownGroups.slice(0, 8)) {
      rows.push([{ text: `💬 ${formatChatLabel(group)}`.slice(0, 60), callback_data: `admin:group:${group.id}` }]);
    }
  }

  if (isLikelyGroupChatId(currentChatId)) {
    rows.push([{ text: "📍 Manage this chat", callback_data: `admin:group:${currentChatId}` }]);
  }

  rows.push([{ text: "🔄 Refresh chats", callback_data: "admin:groups:this" }]);
  rows.push([{ text: "🪪 Admin ID", callback_data: "admin:id:this" }]);
  rows.push([{ text: "🏠 Main menu", callback_data: "admin:main:this" }]);

  return { inline_keyboard: rows };
}

function groupPickerKeyboard(currentChatId, knownGroups) {
  const rows = knownGroups.slice(0, 20).map((group) => [
    { text: `💬 ${formatChatLabel(group)}`.slice(0, 60), callback_data: `admin:group:${group.id}` },
  ]);

  if (isLikelyGroupChatId(currentChatId)) {
    rows.push([{ text: "📍 This chat", callback_data: `admin:group:${currentChatId}` }]);
  }

  rows.push([{ text: "⬅️ Back", callback_data: "admin:panel:this" }]);
  return { inline_keyboard: rows };
}

function multiPickerKeyboard(knownGroups, selectedIds) {
  const selected = new Set(selectedIds);
  const rows = knownGroups.slice(0, 20).map((group) => [
    {
      text: `${selected.has(group.id) ? "✅" : "⬜"} ${formatChatLabel(group)}`.slice(0, 60),
      callback_data: `admin:toggle:${group.id}`,
    },
  ]);

  rows.push([
    { text: "📰 Set news for selected", callback_data: "admin:selected:this" },
  ]);
  rows.push([
    { text: "🧹 Clear", callback_data: "admin:clear:this" },
    { text: "⬅️ Back", callback_data: "admin:panel:this" },
  ]);
  return { inline_keyboard: rows };
}

function adminKeyboard(targetChatId = "this") {
  return {
    inline_keyboard: [
      [
        { text: "📰 Set news", callback_data: `admin:configure:${targetChatId}` },
      ],
      [
        { text: "📊 Status", callback_data: `admin:status:${targetChatId}` },
        { text: "⏳ Timer", callback_data: `admin:timer:${targetChatId}` },
      ],
      [
        { text: "🚀 Send news now", callback_data: `admin:post:${targetChatId}` },
      ],
      [
        { text: "✅ Check chat", callback_data: `admin:check:${targetChatId}` },
        { text: "🧪 Test", callback_data: `admin:test:${targetChatId}` },
      ],
      [
        { text: "▶️ Start", callback_data: `admin:start:${targetChatId}` },
        { text: "⏸ Stop", callback_data: `admin:stop:${targetChatId}` },
      ],
      [
        { text: "📋 List configs", callback_data: "admin:list" },
      ],
      [
        { text: "⬅️ Back", callback_data: "admin:groups:this" },
        { text: "🏠 Main menu", callback_data: "admin:main:this" },
      ],
    ],
  };
}

function topicKeyboard(targetChatId) {
  return {
    inline_keyboard: [
      [
        { text: "₿ Crypto", callback_data: `admin:topic:${targetChatId}:crypto` },
        { text: "🏛 Politics", callback_data: `admin:topic:${targetChatId}:politics` },
      ],
      [{ text: "⬅️ Back", callback_data: `admin:group:${targetChatId}` }],
    ],
  };
}

function intervalKeyboard(targetChatId, topic) {
  return {
    inline_keyboard: [
      [
        { text: "⏱ 15 min", callback_data: `admin:interval:${targetChatId}:${topic}:15` },
        { text: "⏱ 30 min", callback_data: `admin:interval:${targetChatId}:${topic}:30` },
      ],
      [
        { text: "🕐 1 hour", callback_data: `admin:interval:${targetChatId}:${topic}:60` },
        { text: "🕒 3 hours", callback_data: `admin:interval:${targetChatId}:${topic}:180` },
      ],
      [{ text: "⬅️ Back", callback_data: `admin:configure:${targetChatId}` }],
    ],
  };
}

function limitKeyboard(targetChatId, topic, intervalMinutes) {
  return {
    inline_keyboard: [
      [
        { text: "∞ No limit", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}` },
        { text: "5️⃣ 5 posts", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}:5` },
      ],
      [
        { text: "🔟 10 posts", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}:10` },
        { text: "🔢 25 posts", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}:25` },
      ],
      [{ text: "⬅️ Back", callback_data: `admin:topic:${targetChatId}:${topic}` }],
    ],
  };
}

async function findFreshArticle(chatId, topic) {
  const posted = await readJson(POSTED_STORE);
  posted[chatId] ||= [];
  const seen = new Set(posted[chatId]);

  const articles = [];
  for (const feedUrl of NEWS_TOPICS[topic]) {
    try {
      articles.push(...(await fetchRss(feedUrl)));
    } catch (error) {
      console.error(`Feed failed ${feedUrl}:`, error.message);
    }
  }

  const freshArticles = articles
    .map((article) => ({
      ...article,
      fingerprints: articleFingerprints(article),
    }))
    .filter((article) => article.title && article.link && !seen.has(article.link) && !article.fingerprints.some((fingerprint) => seen.has(fingerprint)))
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  const article = freshArticles[0];
  if (!article) return null;

  posted[chatId] = [article.link, ...article.fingerprints, ...posted[chatId]].slice(0, 200);
  await writeJson(POSTED_STORE, posted);
  return article;
}

function articleFingerprints(article) {
  return [
    normalizeArticleLink(article.link) ? `url:${normalizeArticleLink(article.link)}` : null,
    normalizeArticleTitle(article.title) ? `title:${normalizeArticleTitle(article.title)}` : null,
  ].filter(Boolean);
}

function normalizeArticleLink(link) {
  try {
    const url = new URL(String(link || "").trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.hostname}${url.pathname}${url.search}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return String(link || "").trim().toLowerCase();
  }
}

function normalizeArticleTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function fetchRss(feedUrl) {
  const response = await fetch(feedUrl, {
    headers: {
      "user-agent": "tel-news-bot/1.0",
      accept: "application/rss+xml, application/xml, text/xml",
    },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const xml = await response.text();
  const source = decodeXml(
    matchFirst(xml, /<channel>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/channel>/i) ||
      new URL(feedUrl).hostname
  );

  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => {
    const item = match[0];
    const title = decodeXml(matchFirst(item, /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i));
    const link = decodeXml(matchFirst(item, /<link>([\s\S]*?)<\/link>/i)).trim();
    const pubDate = decodeXml(matchFirst(item, /<pubDate>([\s\S]*?)<\/pubDate>/i));

    return {
      title: stripTags(title).trim(),
      link,
      source,
      publishedAt: Date.parse(pubDate) || 0,
    };
  });
}

async function ensureDataStore() {
  if (dataStoreReady) return;
  if (dataStorePromise) return dataStorePromise;

  dataStorePromise = initializeDataStore().catch((error) => {
    dataStorePromise = null;
    throw error;
  });
  await dataStorePromise;
  dataStoreReady = true;
}

async function initializeDataStore() {
  await ensureDataTables();
}

async function ensureDataTables() {
  await db.execute(
    [
      "CREATE TABLE IF NOT EXISTS tel_news_groups (",
      "chat_id VARCHAR(64) NOT NULL,",
      "topic VARCHAR(32) NULL,",
      "interval_minutes INT NULL,",
      "post_limit INT NULL,",
      "post_at VARCHAR(40) NULL,",
      "posts_sent INT NOT NULL DEFAULT 0,",
      "enabled TINYINT(1) NOT NULL DEFAULT 0,",
      "last_manual_post_at VARCHAR(40) NULL,",
      "last_scheduled_post_at VARCHAR(40) NULL,",
      "last_scheduled_attempt_at VARCHAR(40) NULL,",
      "updated_at VARCHAR(40) NULL,",
      "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,",
      "PRIMARY KEY (chat_id)",
      ")",
    ].join(" ")
  );

  await db.execute(
    [
      "CREATE TABLE IF NOT EXISTS tel_news_chats (",
      "chat_id VARCHAR(64) NOT NULL,",
      "title VARCHAR(255) NULL,",
      "chat_type VARCHAR(32) NULL,",
      "username VARCHAR(255) NULL,",
      "source VARCHAR(32) NULL,",
      "updated_at VARCHAR(40) NULL,",
      "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,",
      "PRIMARY KEY (chat_id)",
      ")",
    ].join(" ")
  );

  await db.execute(
    [
      "CREATE TABLE IF NOT EXISTS tel_news_posted (",
      "chat_id VARCHAR(64) NOT NULL,",
      "fingerprint VARCHAR(512) NOT NULL,",
      "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,",
      "PRIMARY KEY (chat_id, fingerprint)",
      ")",
    ].join(" ")
  );

  await db.execute(
    [
      "CREATE TABLE IF NOT EXISTS tel_news_storage_checks (",
      "check_id VARCHAR(96) NOT NULL,",
      "checked_at VARCHAR(40) NOT NULL,",
      "note VARCHAR(255) NULL,",
      "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,",
      "PRIMARY KEY (check_id)",
      ")",
    ].join(" ")
  );
}

function matchFirst(value, regex) {
  const match = value.match(regex);
  if (!match) return "";
  return match.slice(1).find((part) => part !== undefined) || "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readJson(name) {
  await ensureDataStore();
  if (name === GROUPS_STORE) return readGroups();
  if (name === CHATS_STORE) return readChats();
  if (name === POSTED_STORE) return readPosted();
  return {};
}

async function writeJson(name, value) {
  await ensureDataStore();
  if (name === GROUPS_STORE) return writeGroups(value);
  if (name === CHATS_STORE) return writeChats(value);
  if (name === POSTED_STORE) return writePosted(value);
}

async function readGroups() {
  const rows = await db.query("SELECT * FROM tel_news_groups", []);
  const groups = {};

  for (const row of rows) {
    groups[String(row.chat_id)] = {
      topic: row.topic || null,
      intervalMinutes: numberOrNull(row.interval_minutes),
      postLimit: numberOrNull(row.post_limit),
      postAt: row.post_at || null,
      postsSent: Number(row.posts_sent || 0),
      enabled: row.enabled === true || row.enabled === 1 || row.enabled === "1",
      lastManualPostAt: row.last_manual_post_at || null,
      lastScheduledPostAt: row.last_scheduled_post_at || null,
      lastScheduledAttemptAt: row.last_scheduled_attempt_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  return groups;
}

async function writeGroups(groups) {
  for (const [chatId, group] of Object.entries(groups || {})) {
    await db.execute("INSERT IGNORE INTO tel_news_groups (chat_id) VALUES (?)", [chatId]);
    await db.execute(
      [
        "UPDATE tel_news_groups SET",
        "topic = ?, interval_minutes = ?, post_limit = ?, post_at = ?, posts_sent = ?, enabled = ?,",
        "last_manual_post_at = ?, last_scheduled_post_at = ?, last_scheduled_attempt_at = ?, updated_at = ?",
        "WHERE chat_id = ?",
      ].join(" "),
      [
        group.topic || null,
        numberOrNull(group.intervalMinutes),
        numberOrNull(group.postLimit),
        group.postAt || null,
        Number(group.postsSent || 0),
        group.enabled ? 1 : 0,
        group.lastManualPostAt || null,
        group.lastScheduledPostAt || null,
        group.lastScheduledAttemptAt || null,
        group.updatedAt || new Date().toISOString(),
        chatId,
      ]
    );
  }

  const saved = await readGroups();
  for (const chatId of Object.keys(groups || {})) {
    if (!saved[chatId]) throw new Error(`Database write verification failed for ${GROUPS_STORE}:${chatId}`);
  }
}

async function readChats() {
  const rows = await db.query("SELECT * FROM tel_news_chats", []);
  const chats = {};

  for (const row of rows) {
    chats[String(row.chat_id)] = {
      id: String(row.chat_id),
      title: row.title || String(row.chat_id),
      type: row.chat_type || "group",
      username: row.username || null,
      updatedAt: row.updated_at || null,
      source: row.source || "telegram",
    };
  }

  return chats;
}

async function writeChats(chats) {
  for (const [chatId, chat] of Object.entries(chats || {})) {
    await db.execute("INSERT IGNORE INTO tel_news_chats (chat_id) VALUES (?)", [chatId]);
    await db.execute(
      [
        "UPDATE tel_news_chats SET",
        "title = ?, chat_type = ?, username = ?, source = ?, updated_at = ?",
        "WHERE chat_id = ?",
      ].join(" "),
      [
        chat.title || chat.username || chatId,
        chat.type || "group",
        chat.username || null,
        chat.source || "telegram",
        chat.updatedAt || new Date().toISOString(),
        chatId,
      ]
    );
  }
}

async function readPosted() {
  const rows = await db.query("SELECT chat_id, fingerprint FROM tel_news_posted ORDER BY created_at DESC", []);
  const posted = {};

  for (const row of rows) {
    const chatId = String(row.chat_id);
    posted[chatId] ||= [];
    posted[chatId].push(row.fingerprint);
  }

  return posted;
}

async function writePosted(posted) {
  for (const [chatId, fingerprints] of Object.entries(posted || {})) {
    await db.execute("DELETE FROM tel_news_posted WHERE chat_id = ?", [chatId]);
    for (const fingerprint of (fingerprints || []).slice(0, 200)) {
      await db.execute("INSERT IGNORE INTO tel_news_posted (chat_id, fingerprint) VALUES (?, ?)", [chatId, fingerprint]);
    }
  }
}

async function getStorageCounts() {
  const [groups] = await db.query("SELECT COUNT(*) AS count FROM tel_news_groups", []);
  const [chats] = await db.query("SELECT COUNT(*) AS count FROM tel_news_chats", []);
  const [posted] = await db.query("SELECT COUNT(*) AS count FROM tel_news_posted", []);
  const [checks] = await db.query("SELECT COUNT(*) AS count FROM tel_news_storage_checks", []);

  return {
    groups: Number(groups?.count || 0),
    chats: Number(chats?.count || 0),
    posted: Number(posted?.count || 0),
    storageChecks: Number(checks?.count || 0),
  };
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createNewsBotRoute,
};
