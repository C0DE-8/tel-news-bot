function createHttpAdminGuard(adminChatIds) {
  const admins = parseAdminChatIds(adminChatIds);

  return function requireHttpAdmin(req, payload = {}) {
    if (admins.size === 0) return;

    const adminChatId = getAdminChatId(req, payload);
    if (admins.has(adminChatId)) return;

    const error = new Error("Admin access required");
    error.statusCode = 403;
    throw error;
  };
}

function getAdminChatId(req, payload) {
  const url = new URL(req.url, "http://localhost");
  return String(
    req.headers["x-admin-chat-id"] ||
      payload.adminChatId ||
      url.searchParams.get("adminChatId") ||
      ""
  ).trim();
}

function parseAdminChatIds(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

module.exports = {
  createHttpAdminGuard,
};
