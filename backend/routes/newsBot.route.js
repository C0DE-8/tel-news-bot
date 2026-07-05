const fs = require("fs");
const path = require("path");
const { getPathname, sendJson } = require("../utils/http");

const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? path.join("/tmp", "tel-news-bot-data") : path.join(__dirname, "..", "data"));
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const POSTED_FILE = path.join(DATA_DIR, "posted.json");
const CHATS_FILE = path.join(DATA_DIR, "chats.json");

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
    this.restoreScheduledPosts();

    if (this.useWebhook) {
      console.log("Telegram webhook mode enabled.");
      return;
    }

    this.startTelegramPolling();
  }

  getStatus() {
    const groups = fs.existsSync(GROUPS_FILE) ? readJson(GROUPS_FILE) : {};
    const activeGroups = Object.values(groups).filter((group) => group.enabled).length;

    return {
      ok: true,
      running: this.started && Boolean(this.token),
      mode: this.useWebhook ? "webhook" : "polling",
      activeGroups,
      topics: Object.keys(NEWS_TOPICS),
      adminRestricted: this.adminChatIds.size > 0,
    };
  }

  listGroupConfigs() {
    ensureDataFiles();
    return readJson(GROUPS_FILE);
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
    return readJson(GROUPS_FILE)[String(chatId)] || null;
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
      updatedAt: new Date().toISOString(),
    };
    writeJson(GROUPS_FILE, groups);

    if (enabled) {
      this.scheduleGroup(chatId, groups[chatId]);
    } else {
      this.clearGroupTimer(chatId);
    }

    if (payload.postNow === true && enabled) {
      await this.postNewsNow(chatId);
    }

    return groups[chatId];
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

    return groups[normalizedChatId];
  }

  async handleTelegramUpdate(update) {
    if (update.message) {
      this.rememberChat(update.message.chat);
      if (update.message.text) await this.handleMessage(update.message);
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
          allowed_updates: ["message", "callback_query", "my_chat_member"],
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
    const [commandWithBotName, ...args] = text.split(/\s+/);
    const arg = args[0];
    const command = commandWithBotName.split("@")[0].toLowerCase();

    if (!command.startsWith("/")) return;

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
      await this.postNewsNow(chatId);
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

  async handleCallbackQuery(callbackQuery) {
    const message = callbackQuery.message;
    const chatId = String(message?.chat?.id || "");
    const data = String(callbackQuery.data || "");

    if (!chatId || (!data.startsWith("admin:") && !data.startsWith("bot:"))) {
      await this.answerCallbackQuery(callbackQuery.id, "Unknown action.");
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

      if (action === "groups") {
        await this.sendGroupPicker(chatId);
        await this.answerCallbackQuery(callbackQuery.id, "Pick group.");
        return;
      }

      if (action === "group") {
        const group = this.listKnownGroups().find((knownGroup) => knownGroup.id === targetChatId);
        await this.sendMessage(chatId, `Managing ${formatChatLabel(group || { id: targetChatId })}`, {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Group selected.");
        return;
      }

      if (action === "id") {
        await this.sendMessage(chatId, `Your admin id: ${callbackQuery.from?.id || "unknown"}\nThis chat id: ${chatId}`);
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

      if (action === "check") {
        const result = await this.checkGroupAccess(targetChatId);
        await this.sendMessage(chatId, formatGroupAccess(result), {
          replyMarkup: adminKeyboard(targetChatId),
        });
        await this.answerCallbackQuery(callbackQuery.id, "Group checked.");
        return;
      }

      if (action === "test") {
        await this.sendTestMessage(targetChatId);
        await this.answerCallbackQuery(callbackQuery.id, "Test sent.");
        return;
      }

      if (action === "post") {
        await this.postNewsNow(targetChatId);
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
        await this.answerCallbackQuery(callbackQuery.id, "Pick group.");
        return;
      }

      await this.sendChatStatus(targetChatId);
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
        await this.answerCallbackQuery(callbackQuery.id, "Pick group.");
        return;
      }

      await this.postNewsNow(targetChatId);
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

  async sendAdminHelp(chatId, includeButtons = false) {
    const knownGroups = this.listKnownGroups();
    const text = knownGroups.length
      ? "Admin panel\nPick a group below, then choose what the bot should do."
      : "Admin panel\nNo known groups yet. Send any message in the group while the bot is running, then open this panel again.";

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
    await this.sendMessage(chatId, "Admin panel\nPick a group to manage.", {
      replyMarkup: adminHomeKeyboard(chatId, knownGroups),
    });
  }

  async sendGroupPicker(chatId) {
    const knownGroups = this.listKnownGroups();
    await this.sendMessage(chatId, knownGroups.length ? "Pick a group." : "No known groups yet.", {
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
      await this.sendMessage(currentChatId, `Group check failed: ${error.message}`);
    }
  }

  async handleAdminList(chatId) {
    const groups = this.listGroupConfigs();
    const lines = Object.entries(groups).map(([groupChatId, group]) => formatGroupConfig(groupChatId, group));

    await this.sendMessage(chatId, lines.length ? lines.join("\n\n") : "No group configs saved yet.");
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
    await this.sendMessage(
      chatId,
      `News topic set to ${normalizedTopic}. I will post every ${groups[chatId].intervalMinutes} minutes.`
    );
    await this.postNewsNow(chatId);
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
    await this.sendMessage(chatId, `Posting interval set to ${minutes} minutes.`);
  }

  async sendChatStatus(chatId) {
    const groups = readJson(GROUPS_FILE);
    const group = groups[chatId];

    if (!group || !group.enabled) {
      await this.sendMessage(chatId, "News posting is not active. Open the admin panel and choose Set news.", {
        replyMarkup: mainMenuKeyboard(chatId),
      });
      return;
    }

    await this.sendMessage(chatId, `Active topic: ${group.topic}\nInterval: ${group.intervalMinutes} minutes`);
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

  async stopNews(chatId) {
    const groups = readJson(GROUPS_FILE);
    if (groups[chatId]) {
      groups[chatId].enabled = false;
      groups[chatId].updatedAt = new Date().toISOString();
      writeJson(GROUPS_FILE, groups);
    }

    this.clearGroupTimer(chatId);
    await this.sendMessage(chatId, "News posting stopped for this chat.");
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

  async postNewsNow(chatId) {
    const groups = readJson(GROUPS_FILE);
    const group = groups[chatId];
    if (!group?.enabled || !NEWS_TOPICS[group.topic]) {
      await this.sendMessage(chatId, "Set a topic first from the admin panel.", {
        replyMarkup: adminKeyboard(chatId),
      });
      return;
    }

    if (hasReachedPostLimit(group)) {
      group.enabled = false;
      group.updatedAt = new Date().toISOString();
      groups[chatId] = group;
      writeJson(GROUPS_FILE, groups);
      this.clearGroupTimer(chatId);
      return;
    }

    const article = await findFreshArticle(chatId, group.topic);
    if (!article) {
      await this.sendMessage(chatId, `I could not find fresh ${group.topic} news right now. I will try again later.`);
      return;
    }

    await this.sendMessage(
      chatId,
      `<b>${escapeHtml(article.title)}</b>\n\n${escapeHtml(article.source)}\n${escapeHtml(article.link)}`,
      "HTML"
    );

    group.postsSent = Number(group.postsSent || 0) + 1;
    if (hasReachedPostLimit(group)) {
      group.enabled = false;
      this.clearGroupTimer(chatId);
    }
    group.updatedAt = new Date().toISOString();
    groups[chatId] = group;
    writeJson(GROUPS_FILE, groups);
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
      allowed_updates: options.allowedUpdates || ["message", "callback_query", "my_chat_member"],
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

function formatGroupConfig(chatId, group) {
  return [
    `Chat: ${chatId}`,
    `Enabled: ${group.enabled ? "yes" : "no"}`,
    `Topic: ${group.topic || "not set"}`,
    `Every: ${group.intervalMinutes || "not set"} minutes`,
    `Limit: ${group.postLimit || "none"}`,
    `Start: ${group.postAt || "now"}`,
    `Posts sent: ${group.postsSent || 0}`,
  ].join("\n");
}

function formatGroupAccess(result) {
  const chatTitle = result.chat.title || result.chat.username || result.chat.id;
  const member = result.membership;

  return [
    `Group check for ${chatTitle}`,
    `Chat id: ${result.chatId}`,
    `Bot: @${result.bot.username || result.bot.first_name}`,
    `Bot status: ${member.status}`,
    `Can post: ${result.canPost ? "yes" : "no"}`,
    member.can_send_messages === false ? "Reason: can_send_messages is false" : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function canBotPost(member) {
  if (!member || member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.can_send_messages !== false;
  return ["creator", "administrator", "member"].includes(member.status);
}

function mainMenuKeyboard(currentChatId) {
  return {
    inline_keyboard: [
      [
        { text: "Status", callback_data: `bot:status:${currentChatId}` },
        { text: "Latest news", callback_data: `bot:news:${currentChatId}` },
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
    rows.push([{ text: "Pick group", callback_data: "admin:groups:this" }]);
    for (const group of knownGroups.slice(0, 8)) {
      rows.push([{ text: formatChatLabel(group).slice(0, 60), callback_data: `admin:group:${group.id}` }]);
    }
  }

  if (isLikelyGroupChatId(currentChatId)) {
    rows.push([{ text: "Manage this group", callback_data: `admin:group:${currentChatId}` }]);
  }

  rows.push([{ text: "Refresh groups", callback_data: "admin:groups:this" }]);
  rows.push([{ text: "Admin ID", callback_data: "admin:id:this" }]);

  return { inline_keyboard: rows };
}

function groupPickerKeyboard(currentChatId, knownGroups) {
  const rows = knownGroups.slice(0, 20).map((group) => [
    { text: formatChatLabel(group).slice(0, 60), callback_data: `admin:group:${group.id}` },
  ]);

  if (isLikelyGroupChatId(currentChatId)) {
    rows.push([{ text: "This group", callback_data: `admin:group:${currentChatId}` }]);
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
        { text: "Post now", callback_data: `admin:post:${targetChatId}` },
      ],
      [
        { text: "Check group", callback_data: `admin:check:${targetChatId}` },
        { text: "Send test", callback_data: `admin:test:${targetChatId}` },
      ],
      [
        { text: "Stop", callback_data: `admin:stop:${targetChatId}` },
        { text: "List configs", callback_data: "admin:list" },
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
      [{ text: "Back", callback_data: `admin:panel:${targetChatId}` }],
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
    .filter((article) => article.title && article.link && !seen.has(article.link))
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  const article = freshArticles[0];
  if (!article) return null;

  posted[chatId] = [article.link, ...posted[chatId]].slice(0, 100);
  writeJson(POSTED_FILE, posted);
  return article;
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
