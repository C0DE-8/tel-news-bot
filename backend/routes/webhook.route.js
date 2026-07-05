const { getPathname, readJsonBody, sendJson } = require("../utils/http");

function createWebhookRoute({ bot, requireHttpAdmin }) {
  const guard = requireHttpAdmin || (() => {});
  return {
    handle: (req, res) => handleWebhookRoute(req, res, bot, guard),
  };
}

async function handleWebhookRoute(req, res, bot, requireHttpAdmin) {
  const pathname = getPathname(req);

  try {
    if (req.method === "POST" && pathname === "/webhook/telegram/set") {
      const payload = await readJsonBody(req);
      requireHttpAdmin(req, payload);
      const result = await bot.setWebhook(payload.url, {
        allowedUpdates: payload.allowedUpdates,
        dropPendingUpdates: payload.dropPendingUpdates,
      });
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "GET" && pathname === "/webhook/telegram/info") {
      requireHttpAdmin(req);
      const result = await bot.getWebhookInfo();
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (
      (req.method === "DELETE" && pathname === "/webhook/telegram") ||
      (req.method === "POST" && pathname === "/webhook/telegram/delete")
    ) {
      const payload = req.method === "POST" ? await readJsonBody(req) : {};
      requireHttpAdmin(req, payload);
      const result = await bot.deleteWebhook(payload.dropPendingUpdates);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "POST" && pathname === "/webhook/telegram") {
      const update = await readJsonBody(req);
      await bot.handleTelegramUpdate(update);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Route not found",
      routes: [
        "POST /webhook/telegram",
        "POST /webhook/telegram/set",
        "GET /webhook/telegram/info",
        "DELETE /webhook/telegram",
        "POST /webhook/telegram/delete",
      ],
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message,
    });
  }
}

module.exports = {
  createWebhookRoute,
};
