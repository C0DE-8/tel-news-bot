const fs = require("fs");
const path = require("path");
const { getPathname, sendJson } = require("../utils/http");

const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? path.join("/tmp", "tel-news-bot-data") : path.join(__dirname, "..", "data"));
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const POSTED_FILE = path.join(DATA_DIR, "posted.json");
const CHATS_FILE = path.join(DATA_DIR, "chats.json");
const MANUAL_POST_COOLDOWN_MS = 10 * 1000;
const INVESTMENT_SITE_URL = "https://zephyrequi.com";
const INVESTMENT_CODE_REGEX = /\bLF-IPC-(CIVIC|STEWAR|SELECT|DISTIN)-[A-Z0-9]{4}[A-F0-9]{6}\b/i;
const TELEGRAM_ALLOWED_UPDATES = ["message", "channel_post", "callback_query", "my_chat_member"];

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
      sendJson(res, 200, bot.getStatus());
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
  }

  start() {
    if (this.started) return;
    this.started = true;

    if (!this.token) {
      console.error("Missing TELEGRAM_BOT_TOKEN. Add it to backend/.env.");
      return;
    }

    ensureDataFiles();
    if (process.env.VERCEL) {
      console.log("Vercel runtime detected. Scheduled posts use /cron/post-news.");
    } else {
      this.restoreScheduledPosts();
    }

    if (this.useWebhook) {
      console.log("Telegram webhook mode enabled.");
      return;
    }

    this.startTelegramPolling();
  }

  getStatus() {
    const groups = fs.existsSync(GROUPS_FILE) ? readJson(GROUPS_FILE) : {};
    const activeGroups = Object.values(groups).filter((group) => group.enabled).length;
    const now = new Date();

    return {
      ok: true,
      running: this.started && Boolean(this.token),
      mode: this.useWebhook ? "webhook" : "polling",
      activeGroups,
      topics: Object.keys(NEWS_TOPICS),
      adminRestricted: this.adminChatIds.size > 0,
      scheduler: process.env.VERCEL ? "cron-route" : "local-timer",
      schedules: Object.fromEntries(
        Object.entries(groups).map(([chatId, group]) => [chatId, getScheduleStatus(group, now)])
      ),
    };
  }

  listGroupConfigs() {
    ensureDataFiles();
    return addScheduleStatuses(readJson(GROUPS_FILE));
  }

  listKnownGroups() {
    ensureDataFiles();
    const chats = readJson(CHATS_FILE);
    const learnedGroups = Object.values(chats).filter((chat) => isGroupChatType(chat.type));
    const groups = new Map();

    for (const group of this.configuredGroups) groups.set(group.id, group);
    for (const group of learnedGroups) groups.set(group.id, group);

    return [...groups.values()];
  }

  getGroupConfig(chatId) {
    ensureDataFiles();
    const group = readJson(GROUPS_FILE)[String(chatId)] || null;
    return group ? addScheduleStatus(group) : null;
  }

  async configureGroup(payload) {
    ensureDataFiles();

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

    const groups = readJson(GROUPS_FILE);
    const current = groups[chatId] || {};

    groups[chatId] = {
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
    writeJson(GROUPS_FILE, groups);

    if (enabled) {
      this.scheduleGroup(chatId, groups[chatId]);
    } else {
      this.clearGroupTimer(chatId);
    }

    if (payload.postNow === true && enabled) {
      await this.postNewsNow(chatId, { manual: true });
    }

    await this.sendAdminUpdate(
      [
        "News config saved.",
        `Group: ${chatId}`,
        `Topic: ${topic}`,
        `Every: ${intervalMinutes} minutes`,
        `Limit: ${postLimit || "none"}`,
        process.env.VERCEL ? "Scheduler: Vercel cron route /cron/post-news" : "Scheduler: local timer",
      ].join("\n"),
      { replyMarkup: adminKeyboard(chatId) }
    );

    return addScheduleStatus(groups[chatId]);
  }

  disableGroup(chatId) {
    ensureDataFiles();

    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throwHttpError(400, "chatId is required");

    const groups = readJson(GROUPS_FILE);
    const current = groups[normalizedChatId] || {};
    groups[normalizedChatId] = {
      ...current,
      enabled: false,
      updatedAt: new Date().toISOString(),
    };
    writeJson(GROUPS_FILE, groups);
    this.clearGroupTimer(normalizedChatId);

    return addScheduleStatus(groups[normalizedChatId]);
  }

  enableGroup(chatId) {
    ensureDataFiles();

    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throwHttpError(400, "chatId is required");

    const groups = readJson(GROUPS_FILE);
    const current = groups[normalizedChatId];
    if (!current?.topic || !NEWS_TOPICS[current.topic]) {
      throwHttpError(404, "No saved news config found. Set news for this chat first.");
    }

    groups[normalizedChatId] = {
      ...current,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    writeJson(GROUPS_FILE, groups);
    this.scheduleGroup(normalizedChatId, groups[normalizedChatId]);

    return addScheduleStatus(groups[normalizedChatId]);
  }

  async handleTelegramUpdate(update) {
    if (update.message) {
      this.rememberChat(update.message.chat);
      if (update.message.text) await this.handleMessage(update.message);
      return;
    }

    if (update.channel_post) {
      this.rememberChat(update.channel_post.chat);
      if (update.channel_post.text) await this.handleMessage(update.channel_post);
      return;
    }

    if (update.callback_query) {
      this.rememberChat(update.callback_query.message?.chat);
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    if (update.my_chat_member) {
      this.rememberChat(update.my_chat_member.chat);
    }
  }

  rememberChat(chat) {
    if (!chat?.id || !isGroupChatType(chat.type)) return;

    ensureDataFiles();
    const chats = readJson(CHATS_FILE);
    const chatId = String(chat.id);
    chats[chatId] = {
      id: chatId,
      title: chat.title || chat.username || chat.first_name || chatId,
      type: chat.type,
      username: chat.username || null,
      updatedAt: new Date().toISOString(),
    };
    writeJson(CHATS_FILE, chats);
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

      if (action === "group") {
        const group = this.listKnownGroups().find((knownGroup) => knownGroup.id === targetChatId);
        await this.sendMessage(chatId, `Managing ${formatChatLabel(group || { id: targetChatId })}`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Chat selected.");
        return;
      }

      if (action === "id") {
        await this.sendMessage(chatId, `Your admin id: ${callbackQuery.from?.id || "unknown"}\nThis chat id: ${chatId}`, {
          replyMarkup: adminHomeKeyboard(chatId, this.listKnownGroups()),
        });
        await this.answerCallbackQuery(callbackQuery.id, "ID sent.");
        return;
      }

      if (action === "configure") {
        await this.sendMessage(chatId, "Pick the news topic for this chat.", {
          replyMarkup: topicKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Choose topic.");
        return;
      }

      if (action === "topic") {
        await this.sendMessage(chatId, `Topic selected: ${topic}\nPick how often to post.`, {
          replyMarkup: intervalKeyboard(targetChatId, topic),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Choose interval.");
        return;
      }

      if (action === "interval") {
        await this.sendMessage(chatId, `Interval selected: ${intervalMinutes} minutes\nPick how many posts to send.`, {
          replyMarkup: limitKeyboard(targetChatId, topic, intervalMinutes),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Choose limit.");
        return;
      }

      if (action === "set") {
        const group = await this.configureGroup({
          chatId: targetChatId,
          topic,
          intervalMinutes,
          postLimit,
        });
        await this.sendMessage(chatId, `Saved from button.\n${formatGroupConfig(targetChatId, group)}`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Saved.");
        return;
      }

      if (action === "status") {
        const group = this.getGroupConfig(targetChatId);
        await this.sendMessage(chatId, group ? formatGroupConfig(targetChatId, group) : `No config found for ${targetChatId}.`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Status sent.");
        return;
      }

      if (action === "cron") {
        const group = this.getGroupConfig(targetChatId);
        await this.sendMessage(chatId, group ? formatCronStatus(targetChatId, group) : `No config found for ${targetChatId}.`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Cron status sent.");
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
        this.disableGroup(targetChatId);
        await this.sendMessage(chatId, `News stopped for ${targetChatId}.`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Stopped.");
        return;
      }

      if (action === "start") {
        const group = this.enableGroup(targetChatId);
        await this.sendMessage(chatId, `News started for ${targetChatId}.\n${formatGroupConfig(targetChatId, group)}`, {
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
    const knownGroups = this.listKnownGroups();
    const text = knownGroups.length
      ? "Admin panel\nPick a chat below, then choose what the bot should do."
      : "Admin panel\nNo known chats yet. Add the bot to a channel/group or set TELEGRAM_GROUP_CHAT_IDS, then open this panel again.";

    await this.sendMessage(
      chatId,
      text,
      includeButtons ? { replyMarkup: adminHomeKeyboard(chatId, knownGroups) } : undefined
    );
  }

  async sendMainMenu(chatId) {
    await this.sendMessage(chatId, "Choose an action.", {
      replyMarkup: mainMenuKeyboard(chatId),
    });
  }

  async sendAdminPanel(chatId) {
    const knownGroups = this.listKnownGroups();
    await this.sendMessage(chatId, "Admin panel\nPick a chat to manage.", {
      replyMarkup: adminHomeKeyboard(chatId, knownGroups),
    });
  }

  async sendGroupPicker(chatId) {
    const knownGroups = this.listKnownGroups();
    await this.sendMessage(chatId, knownGroups.length ? "Pick a chat." : "No known chats yet.", {
      replyMarkup: groupPickerKeyboard(chatId, knownGroups),
    });
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
      this.disableGroup(targetChatId);
      await this.sendMessage(currentChatId, `News stopped for ${targetChatId}.`);
    } catch (error) {
      await this.sendMessage(currentChatId, `Stop failed: ${error.message}`);
    }
  }

  async handleAdminStatus(currentChatId, args) {
    const targetChatId = normalizeTargetChatId(args[0], currentChatId);
    const group = this.getGroupConfig(targetChatId);

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
    const groups = this.listGroupConfigs();
    const lines = Object.entries(groups).map(([groupChatId, group]) => formatGroupConfig(groupChatId, group));

    await this.sendMessage(chatId, lines.length ? lines.join("\n\n") : "No chat configs saved yet.", {
      replyMarkup: adminHomeKeyboard(chatId, this.listKnownGroups()),
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

    const groups = readJson(GROUPS_FILE);
    groups[chatId] = {
      topic: normalizedTopic,
      intervalMinutes: groups[chatId]?.intervalMinutes || this.defaultIntervalMinutes,
      postLimit: null,
      postAt: null,
      postsSent: 0,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    writeJson(GROUPS_FILE, groups);

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

    const groups = readJson(GROUPS_FILE);
    if (!groups[chatId]) {
      await this.sendMessage(chatId, "Set a topic first from the admin panel.", {
        replyMarkup: adminKeyboard(chatId),
      });
      return;
    }

    groups[chatId].intervalMinutes = minutes;
    groups[chatId].enabled = true;
    groups[chatId].updatedAt = new Date().toISOString();
    writeJson(GROUPS_FILE, groups);

    this.scheduleGroup(chatId, groups[chatId]);
    await this.sendAdminUpdate(`Posting interval set for ${chatId}: ${minutes} minutes.`);
  }

  async sendChatStatus(outputChatId, targetChatId = outputChatId) {
    const groups = readJson(GROUPS_FILE);
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
    this.rememberChat(chat.result);
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

  async runDuePosts(now = new Date()) {
    ensureDataFiles();
    const groups = readJson(GROUPS_FILE);
    const summary = {
      ok: true,
      checkedAt: now.toISOString(),
      checked: 0,
      posted: 0,
      skipped: 0,
      schedules: {},
      errors: [],
    };

    for (const [chatId, group] of Object.entries(groups)) {
      summary.checked += 1;
      summary.schedules[chatId] = getScheduleStatus(group, now);

      if (!group.enabled || !NEWS_TOPICS[group.topic]) {
        summary.skipped += 1;
        continue;
      }

      const due = getScheduleDueState(group, now);
      if (!due.ready) {
        summary.skipped += 1;
        continue;
      }

      groups[chatId] = {
        ...group,
        lastScheduledAttemptAt: now.toISOString(),
      };
      writeJson(GROUPS_FILE, groups);

      try {
        const result = await this.postNewsNow(chatId, { scheduled: true, now });
        if (result?.posted) {
          summary.posted += 1;
        } else {
          summary.skipped += 1;
        }
        const latestGroups = readJson(GROUPS_FILE);
        summary.schedules[chatId] = getScheduleStatus(latestGroups[chatId], now);
      } catch (error) {
        summary.errors.push({ chatId, error: error.message });
        await this.sendAdminUpdate(`Scheduled post failed for ${chatId}: ${error.message}`);
      }
    }

    if (summary.posted || summary.errors.length) {
      await this.sendAdminUpdate(
        [
          "Cron post check finished.",
          `Checked: ${summary.checked}`,
          `Posted: ${summary.posted}`,
          `Skipped: ${summary.skipped}`,
          `Errors: ${summary.errors.length}`,
        ].join("\n")
      );
    }

    return summary;
  }

  async stopNews(chatId) {
    const groups = readJson(GROUPS_FILE);
    if (groups[chatId]) {
      groups[chatId].enabled = false;
      groups[chatId].updatedAt = new Date().toISOString();
      writeJson(GROUPS_FILE, groups);
    }

    this.clearGroupTimer(chatId);
    await this.sendAdminUpdate(`News posting stopped for ${chatId}.`);
  }

  restoreScheduledPosts() {
    const groups = readJson(GROUPS_FILE);
    for (const [chatId, group] of Object.entries(groups)) {
      if (group.enabled) this.scheduleGroup(chatId, group);
    }
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
          const current = this.getGroupConfig(chatId);
          if (current?.enabled) startInterval();
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
    const groups = readJson(GROUPS_FILE);
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
      writeJson(GROUPS_FILE, groups);
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
    writeJson(GROUPS_FILE, groups);

    await this.sendAdminUpdate(
      [
        `${options.scheduled ? "Scheduled" : options.manual ? "Manual" : "News"} post sent.`,
        `Group: ${normalizedChatId}`,
        `Topic: ${group.topic}`,
        `Title: ${article.title}`,
        group.enabled ? `Posts sent: ${group.postsSent}` : "Post limit reached. News stopped.",
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
        type: "group",
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

function isGroupChatType(type) {
  return ["group", "supergroup", "channel"].includes(type);
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
    `Chat: ${chatId}`,
    `Enabled: ${group.enabled ? "yes" : "no"}`,
    `Topic: ${group.topic || "not set"}`,
    `Every: ${group.intervalMinutes || "not set"} minutes`,
    `Limit: ${group.postLimit || "none"}`,
    `Start: ${group.postAt || "now"}`,
    `Posts sent: ${group.postsSent || 0}`,
    ...formatScheduleLines(group),
  ].join("\n");
}

function formatCronStatus(chatId, group) {
  const status = group.schedule || getScheduleStatus(group);

  return [
    `Cron status for ${chatId}`,
    `Enabled: ${status.enabled ? "yes" : "no"}`,
    `Due: ${status.due ? "yes" : "no"}`,
    `Reason: ${status.reason}`,
    `Interval: ${status.intervalMinutes || group.intervalMinutes || "not set"} minutes`,
    status.enabled ? `Next post: ${status.due ? "due now" : status.countdown}` : null,
    status.enabled ? `Next post at: ${status.nextPostAt}` : null,
    `Posts sent: ${status.postsSent ?? Number(group.postsSent || 0)}`,
    status.postLimit ? `Post limit: ${status.postLimit}` : "Post limit: none",
    status.postLimit ? `Posts remaining: ${status.postsRemaining}` : null,
    `Last post: ${status.lastScheduledPostAt || "none"}`,
    `Last cron check: ${status.lastScheduledAttemptAt || "none"}`,
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
        { text: "Status", callback_data: `bot:status:${currentChatId}` },
        { text: "Send news now", callback_data: `bot:news:${currentChatId}` },
      ],
      [
        { text: "Admin panel", callback_data: `bot:admin:${currentChatId}` },
        { text: "Admin ID", callback_data: "bot:id:this" },
      ],
    ],
  };
}

function adminHomeKeyboard(currentChatId, knownGroups) {
  const rows = [];

  if (knownGroups.length) {
    rows.push([{ text: "Pick chat", callback_data: "admin:groups:this" }]);
    for (const group of knownGroups.slice(0, 8)) {
      rows.push([{ text: formatChatLabel(group).slice(0, 60), callback_data: `admin:group:${group.id}` }]);
    }
  }

  if (isLikelyGroupChatId(currentChatId)) {
    rows.push([{ text: "Manage this chat", callback_data: `admin:group:${currentChatId}` }]);
  }

  rows.push([{ text: "Refresh chats", callback_data: "admin:groups:this" }]);
  rows.push([{ text: "Admin ID", callback_data: "admin:id:this" }]);
  rows.push([{ text: "Main menu", callback_data: "admin:main:this" }]);

  return { inline_keyboard: rows };
}

function groupPickerKeyboard(currentChatId, knownGroups) {
  const rows = knownGroups.slice(0, 20).map((group) => [
    { text: formatChatLabel(group).slice(0, 60), callback_data: `admin:group:${group.id}` },
  ]);

  if (isLikelyGroupChatId(currentChatId)) {
    rows.push([{ text: "This chat", callback_data: `admin:group:${currentChatId}` }]);
  }

  rows.push([{ text: "Back", callback_data: "admin:panel:this" }]);
  return { inline_keyboard: rows };
}

function adminKeyboard(targetChatId = "this") {
  return {
    inline_keyboard: [
      [
        { text: "Set news", callback_data: `admin:configure:${targetChatId}` },
      ],
      [
        { text: "Status", callback_data: `admin:status:${targetChatId}` },
        { text: "Cron status", callback_data: `admin:cron:${targetChatId}` },
      ],
      [
        { text: "Send news now", callback_data: `admin:post:${targetChatId}` },
      ],
      [
        { text: "Check chat", callback_data: `admin:check:${targetChatId}` },
        { text: "Send test", callback_data: `admin:test:${targetChatId}` },
      ],
      [
        { text: "Start", callback_data: `admin:start:${targetChatId}` },
        { text: "Stop", callback_data: `admin:stop:${targetChatId}` },
      ],
      [
        { text: "List configs", callback_data: "admin:list" },
      ],
      [
        { text: "Back", callback_data: "admin:groups:this" },
        { text: "Main menu", callback_data: "admin:main:this" },
      ],
    ],
  };
}

function topicKeyboard(targetChatId) {
  return {
    inline_keyboard: [
      [
        { text: "Crypto", callback_data: `admin:topic:${targetChatId}:crypto` },
        { text: "Politics", callback_data: `admin:topic:${targetChatId}:politics` },
      ],
      [{ text: "Back", callback_data: `admin:group:${targetChatId}` }],
    ],
  };
}

function intervalKeyboard(targetChatId, topic) {
  return {
    inline_keyboard: [
      [
        { text: "15 min", callback_data: `admin:interval:${targetChatId}:${topic}:15` },
        { text: "30 min", callback_data: `admin:interval:${targetChatId}:${topic}:30` },
      ],
      [
        { text: "1 hour", callback_data: `admin:interval:${targetChatId}:${topic}:60` },
        { text: "3 hours", callback_data: `admin:interval:${targetChatId}:${topic}:180` },
      ],
      [{ text: "Back", callback_data: `admin:configure:${targetChatId}` }],
    ],
  };
}

function limitKeyboard(targetChatId, topic, intervalMinutes) {
  return {
    inline_keyboard: [
      [
        { text: "No limit", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}` },
        { text: "5 posts", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}:5` },
      ],
      [
        { text: "10 posts", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}:10` },
        { text: "25 posts", callback_data: `admin:set:${targetChatId}:${topic}:${intervalMinutes}:25` },
      ],
      [{ text: "Back", callback_data: `admin:topic:${targetChatId}:${topic}` }],
    ],
  };
}

async function findFreshArticle(chatId, topic) {
  const posted = readJson(POSTED_FILE);
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
  writeJson(POSTED_FILE, posted);
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

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(GROUPS_FILE)) writeJson(GROUPS_FILE, {});
  if (!fs.existsSync(POSTED_FILE)) writeJson(POSTED_FILE, {});
  if (!fs.existsSync(CHATS_FILE)) writeJson(CHATS_FILE, {});
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createNewsBotRoute,
};
