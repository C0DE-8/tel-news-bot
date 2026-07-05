function createAdminController({ bot }) {
  return {
    listConfigs: () => bot.listGroupConfigs(),
    getConfig: (chatId) => bot.getGroupConfig(chatId),
    configureNews: (payload) => bot.configureGroup(payload),
    stopNews: (chatId) => bot.disableGroup(chatId),
  };
}

module.exports = {
  createAdminController,
};
