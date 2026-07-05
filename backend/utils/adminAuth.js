function createHttpAdminGuard(adminChatIds) {
  const admins = parseAdminChatIds(adminChatIds);

  return function requireHttpAdmin() {
    if (admins.size > 0) return;

    const error = new Error("Admin access required");
    error.statusCode = 403;
    throw error;
  };
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
