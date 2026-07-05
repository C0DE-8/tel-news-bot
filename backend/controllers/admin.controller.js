function createAdminController({ bot }) {
  return {
    listConfigs: () => bot.listGroupConfigs(),
    listGroups: () => bot.listKnownGroups(),
    getConfig: (chatId) => bot.getGroupConfig(chatId),
    configureNews: (payload) => bot.configureGroup(payload),
    stopNews: (chatId) => bot.disableGroup(chatId),
    checkGroup: (chatId) => bot.checkGroupAccess(chatId),
    sendTestMessage: (payload) => bot.sendTestMessage(payload.chatId, payload.text),
  };
}

module.exports = {
  createAdminController,
};
