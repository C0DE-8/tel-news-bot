const fs = require("fs");
const path = require("path");
const http = require("http");
const { createAdminController } = require("./controllers/admin.controller");
const { createAdminRoute } = require("./routes/admin.route");
const { createNewsBotRoute } = require("./routes/newsBot.route");
const { createTestRoute } = require("./routes/test.route");
const { createWebhookRoute } = require("./routes/webhook.route");
const { createHttpAdminGuard } = require("./utils/adminAuth");
const { getPathname, sendJson } = require("./utils/http");

loadEnv();

const db = require("./db");
const APP_VERSION = "sql-normalized-v6-multi-chat-dedupe";
const PORT = Number(process.env.PORT || 3000);
const requireHttpAdmin = createHttpAdminGuard(process.env.TELEGRAM_ADMIN_CHAT_IDS);
const newsBotRoute = createNewsBotRoute({
  token: process.env.TELEGRAM_BOT_TOKEN,
  defaultIntervalMinutes: Number(process.env.POST_INTERVAL_MINUTES || 30),
  useWebhook: process.env.TELEGRAM_USE_WEBHOOK === "true",
  adminChatIds: process.env.TELEGRAM_ADMIN_CHAT_IDS,
  groupChatIds: process.env.TELEGRAM_GROUP_CHAT_IDS,
  requireHttpAdmin,
});
const adminController = createAdminController({ bot: newsBotRoute.bot });
const adminRoute = createAdminRoute({ controller: adminController, requireHttpAdmin });
const webhookRoute = createWebhookRoute({ bot: newsBotRoute.bot, requireHttpAdmin });
const testRoute = createTestRoute({ bot: newsBotRoute.bot, requireHttpAdmin });

const server = http.createServer(async (req, res) => {
  const pathname = getPathname(req);

  if (pathname === "/health") {
    try {
      const status = await db.status();
      sendJson(res, 200, { ok: true, gateway: status });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === "/version") {
    sendJson(res, 200, {
      ok: true,
      service: "Telegram news bot",
      version: APP_VERSION,
      storage: {
        type: "sql",
        tables: ["tel_news_groups", "tel_news_chats", "tel_news_posted", "tel_news_storage_checks"],
        legacyFileStore: false,
        legacyTmpPath: false,
        dbGatewayFallback: true,
      },
      runtime: {
        vercel: Boolean(process.env.VERCEL),
        useWebhook: process.env.TELEGRAM_USE_WEBHOOK === "true",
      },
    });
    return;
  }

  if (pathname.startsWith("/bot")) {
    await newsBotRoute.handle(req, res);
    return;
  }

  if (pathname.startsWith("/admin")) {
    await adminRoute.handle(req, res);
    return;
  }

  if (pathname.startsWith("/webhook")) {
    await webhookRoute.handle(req, res);
    return;
  }

  if (pathname.startsWith("/test")) {
    await testRoute.handle(req, res);
    return;
  }

  sendJson(res, 200, {
    ok: true,
    service: "Telegram news bot",
    routes: [
      "GET /health",
      "GET /version",
      "GET /bot/status",
      "GET /admin/news-config",
      "GET /admin/groups",
      "GET /admin/groups?check=true",
      "POST /admin/groups",
      "POST /admin/groups/refresh",
      "GET /admin/storage-check",
      "POST /admin/storage-check",
      "GET /admin/news-config/:chatId",
      "POST /admin/news-config",
      "POST /admin/news-due",
      "POST /admin/news-start",
      "POST /admin/news-stop",
      "POST /admin/group-check",
      "GET /admin/group-check/:chatId",
      "POST /admin/group-test-message",
      "POST /webhook/telegram",
      "POST /webhook/telegram/set",
      "GET /webhook/telegram/info",
      "DELETE /webhook/telegram",
      "POST /webhook/telegram/delete",
      "GET /test/ping",
      "POST /test/update",
      "Telegram /adminhelp",
      "Telegram /adminid",
      "Telegram /adminset",
      "Telegram /adminstop",
      "Telegram /adminlist",
    ],
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  newsBotRoute.start();
});

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
