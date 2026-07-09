function createAdminController({ bot }) {
  return {
    listConfigs: () => bot.listGroupConfigs(),
    listGroups: (options) => bot.listKnownGroups(options),
    addGroup: (payload) => bot.addKnownGroup(payload),
    refreshGroups: () => bot.refreshKnownGroups(),
    getConfig: (chatId) => bot.getGroupConfig(chatId),
    configureNews: (payload) => bot.configureGroups(payload),
    startNews: (chatId) => bot.enableGroup(chatId),
    stopNews: (chatId) => bot.disableGroup(chatId),
    runDuePosts: () => bot.processDuePosts({ source: "admin-route" }),
    checkGroup: (chatId) => bot.checkGroupAccess(chatId),
    sendTestMessage: (payload) => bot.sendTestMessage(payload.chatId, payload.text),
    storageCheck: () => bot.storageCheck(),
  };
}

module.exports = {
  createAdminController,
};
