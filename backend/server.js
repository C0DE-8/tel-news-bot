const fs = require("fs");
const path = require("path");
const http = require("http");
const { createAdminController } = require("./controllers/admin.controller");
const { createAdminRoute } = require("./routes/admin.route");
const { createNewsBotRoute } = require("./routes/newsBot.route");
const { createTestRoute } = require("./routes/test.route");
const { createWebhookRoute } = require("./routes/webhook.route");
const { getPathname, sendJson } = require("./utils/http");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const newsBotRoute = createNewsBotRoute({
  token: process.env.TELEGRAM_BOT_TOKEN,
  defaultIntervalMinutes: Number(process.env.POST_INTERVAL_MINUTES || 30),
  useWebhook: process.env.TELEGRAM_USE_WEBHOOK === "true",
});
const adminController = createAdminController({ bot: newsBotRoute.bot });
const adminRoute = createAdminRoute({ controller: adminController });
const webhookRoute = createWebhookRoute({ bot: newsBotRoute.bot });
const testRoute = createTestRoute({ bot: newsBotRoute.bot });

const server = http.createServer(async (req, res) => {
  const pathname = getPathname(req);

  if (pathname === "/health") {
    sendJson(res, 200, { ok: true });
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
      "GET /bot/status",
      "GET /admin/news-config",
      "GET /admin/news-config/:chatId",
      "POST /admin/news-config",
      "POST /admin/news-stop",
      "POST /webhook/telegram",
      "GET /test/ping",
      "POST /test/update",
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
