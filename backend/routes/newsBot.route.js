const fs = require("fs");
const path = require("path");
const { getPathname, sendJson } = require("../utils/http");

const DATA_DIR = path.join(__dirname, "..", "data");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const POSTED_FILE = path.join(DATA_DIR, "posted.json");

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

function createNewsBotRoute({ token, defaultIntervalMinutes, useWebhook }) {
  const bot = new NewsBot({
    token,
    defaultIntervalMinutes,
    useWebhook,
  });

  return {
    bot,
    start: () => bot.start(),
    handle: (req, res) => handleRoute(req, res, bot),
  };
}

async function handleRoute(req, res, bot) {
  const pathname = getPathname(req);

  if (req.method === "GET" && pathname === "/bot/status") {
    sendJson(res, 200, bot.getStatus());
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "Route not found",
    routes: ["GET /bot/status"],
  });
}

class NewsBot {
  constructor({ token, defaultIntervalMinutes, useWebhook }) {
    this.token = token;
    this.defaultIntervalMinutes = defaultIntervalMinutes;
    this.useWebhook = Boolean(useWebhook);
    this.offset = 0;
    this.started = false;
    this.groupTimers = new Map();
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
    };
  }

  listGroupConfigs() {
    ensureDataFiles();
    return readJson(GROUPS_FILE);
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
    if (update.message?.text) {
      await this.handleMessage(update.message);
    }
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
          allowed_updates: ["message"],
        });

        for (const update of updates.result || []) {
          this.offset = update.update_id + 1;
          if (update.message?.text) await this.handleMessage(update.message);
        }
      } catch (error) {
        console.error("Polling error:", error.message);
        await sleep(3000);
      }
    }
  }

  async handleMessage(message) {
    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const [commandWithBotName, arg] = text.split(/\s+/, 2);
    const command = commandWithBotName.split("@")[0].toLowerCase();

    if (!command.startsWith("/")) return;

    if (command === "/start" || command === "/help") {
      await this.sendMessage(
        chatId,
        "Commands:\n/setnews crypto\n/setnews politics\n/news\n/status\n/setinterval 30\n/stopnews"
      );
      return;
    }

    if (command === "/setnews") {
      await this.setNewsTopic(chatId, arg);
      return;
    }

    if (command === "/news") {
      await this.postNewsNow(chatId);
      return;
    }

    if (command === "/status") {
      await this.sendChatStatus(chatId);
      return;
    }

    if (command === "/setinterval") {
      await this.setIntervalMinutes(chatId, arg);
      return;
    }

    if (command === "/stopnews") {
      await this.stopNews(chatId);
    }
  }

  async setNewsTopic(chatId, topic) {
    const normalizedTopic = String(topic || "").toLowerCase();
    if (!NEWS_TOPICS[normalizedTopic]) {
      await this.sendMessage(chatId, "Choose a valid topic: crypto or politics.\nExample: /setnews crypto");
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
      await this.sendMessage(chatId, "Use a whole number from 5 to 1440.\nExample: /setinterval 30");
      return;
    }

    const groups = readJson(GROUPS_FILE);
    if (!groups[chatId]) {
      await this.sendMessage(chatId, "Set a topic first.\nExample: /setnews crypto");
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
      await this.sendMessage(chatId, "News posting is not active. Use /setnews crypto or /setnews politics.");
      return;
    }

    await this.sendMessage(chatId, `Active topic: ${group.topic}\nInterval: ${group.intervalMinutes} minutes`);
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
      await this.sendMessage(chatId, "Set a topic first.\nExample: /setnews crypto");
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

  async sendMessage(chatId, text, parseMode) {
    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    };

    if (parseMode) payload.parse_mode = parseMode;
    await this.telegram("sendMessage", payload);
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createNewsBotRoute,
};
