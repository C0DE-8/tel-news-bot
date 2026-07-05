const { getPathname, readJsonBody, sendJson } = require("../utils/http");

function createWebhookRoute({ bot }) {
  return {
    handle: (req, res) => handleWebhookRoute(req, res, bot),
  };
}

async function handleWebhookRoute(req, res, bot) {
  const pathname = getPathname(req);

  try {
    if (req.method === "POST" && pathname === "/webhook/telegram") {
      const update = await readJsonBody(req);
      await bot.handleTelegramUpdate(update);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Route not found",
      routes: ["POST /webhook/telegram"],
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
