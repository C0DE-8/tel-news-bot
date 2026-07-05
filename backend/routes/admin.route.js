const { getPathname, readJsonBody, sendJson } = require("../utils/http");

function createAdminRoute({ controller }) {
  return {
    handle: (req, res) => handleAdminRoute(req, res, controller),
  };
}

async function handleAdminRoute(req, res, controller) {
  const pathname = getPathname(req);

  try {
    if (req.method === "GET" && pathname === "/admin/news-config") {
      sendJson(res, 200, {
        ok: true,
        groups: controller.listConfigs(),
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/admin/news-config/")) {
      const chatId = decodeURIComponent(pathname.replace("/admin/news-config/", ""));
      const group = controller.getConfig(chatId);

      if (!group) {
        sendJson(res, 404, { ok: false, error: "Group config not found" });
        return;
      }

      sendJson(res, 200, { ok: true, group });
      return;
    }

    if (req.method === "POST" && pathname === "/admin/news-config") {
      const payload = await readJsonBody(req);
      const group = await controller.configureNews(payload);
      sendJson(res, 200, { ok: true, group });
      return;
    }

    if (req.method === "POST" && pathname === "/admin/news-stop") {
      const payload = await readJsonBody(req);
      const group = controller.stopNews(payload.chatId);
      sendJson(res, 200, { ok: true, group });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Route not found",
      routes: [
        "GET /admin/news-config",
        "GET /admin/news-config/:chatId",
        "POST /admin/news-config",
        "POST /admin/news-stop",
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
  createAdminRoute,
};
