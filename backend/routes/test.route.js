const { getPathname, readJsonBody, sendJson } = require("../utils/http");

function createTestRoute({ bot }) {
  return {
    handle: (req, res) => handleTestRoute(req, res, bot),
  };
}

async function handleTestRoute(req, res, bot) {
  const pathname = getPathname(req);

  try {
    if (req.method === "GET" && pathname === "/test/ping") {
      sendJson(res, 200, {
        ok: true,
        message: "pong",
        bot: bot.getStatus(),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/test/update") {
      const update = await readJsonBody(req);
      await bot.handleTelegramUpdate(update);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Route not found",
      routes: ["GET /test/ping", "POST /test/update"],
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message,
    });
  }
}

module.exports = {
  createTestRoute,
};
