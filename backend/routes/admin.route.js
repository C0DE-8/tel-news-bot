const { getPathname, readJsonBody, sendJson } = require("../utils/http");

function createAdminRoute({ controller, requireHttpAdmin }) {
  const guard = requireHttpAdmin || (() => {});
  return {
    handle: (req, res) => handleAdminRoute(req, res, controller, guard),
  };
}

async function handleAdminRoute(req, res, controller, requireHttpAdmin) {
  const pathname = getPathname(req);

  try {
    if (req.method === "GET" && pathname === "/admin/news-config") {
      requireHttpAdmin(req);
      sendJson(res, 200, {
        ok: true,
        groups: controller.listConfigs(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/admin/groups") {
      requireHttpAdmin(req);
      sendJson(res, 200, {
        ok: true,
        groups: controller.listGroups(),
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/admin/news-config/")) {
      requireHttpAdmin(req);
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
      requireHttpAdmin(req, payload);
      const group = await controller.configureNews(payload);
      sendJson(res, 200, { ok: true, group });
      return;
    }

    if (req.method === "POST" && pathname === "/admin/news-stop") {
      const payload = await readJsonBody(req);
      requireHttpAdmin(req, payload);
      const group = controller.stopNews(payload.chatId);
      sendJson(res, 200, { ok: true, group });
      return;
    }

    if (req.method === "POST" && pathname === "/admin/group-check") {
      const payload = await readJsonBody(req);
      requireHttpAdmin(req, payload);
      const result = await controller.checkGroup(payload.chatId);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/admin/group-check/")) {
      requireHttpAdmin(req);
      const chatId = decodeURIComponent(pathname.replace("/admin/group-check/", ""));
      const result = await controller.checkGroup(chatId);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "POST" && pathname === "/admin/group-test-message") {
      const payload = await readJsonBody(req);
      requireHttpAdmin(req, payload);
      const result = await controller.sendTestMessage(payload);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Route not found",
      routes: [
        "GET /admin/news-config",
        "GET /admin/groups",
        "GET /admin/news-config/:chatId",
        "POST /admin/news-config",
        "POST /admin/news-stop",
        "POST /admin/group-check",
        "GET /admin/group-check/:chatId",
        "POST /admin/group-test-message",
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
