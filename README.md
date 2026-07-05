# tel-news-bot

A Telegram bot that posts real news into groups on a schedule. Each group can choose the type of news it wants:

- `crypto`
- `politics`

## Setup

1. Create a bot with Telegram's `@BotFather` and copy the bot token.
2. In `backend/.env`, add:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
POST_INTERVAL_MINUTES=30
TELEGRAM_USE_WEBHOOK=false
TELEGRAM_ADMIN_CHAT_IDS=6112214313
TELEGRAM_GROUP_CHAT_IDS=-4586389005|Main News Group
```

3. Start the bot:

```bash
cd backend
npm start
```

For development with nodemon:

```bash
cd backend
npm run dev
```

## Telegram Buttons

Press the bot's `Start` button once to open the button menu. After that, manage the bot from Telegram buttons:

```text
Status
Send news now
Admin panel
Admin ID
Set news
Check group
Send test
Send news now
Stop
List configs
```

The bot stores group settings in `backend/data/groups.json`.

If `TELEGRAM_ADMIN_CHAT_IDS` is set, only those Telegram users can change settings or force posts.
Use the `Admin panel` button to manage the bot. The panel has an `Admin ID` button if you need your Telegram user id.
The group picker shows groups from `TELEGRAM_GROUP_CHAT_IDS` plus groups the bot has seen while running. On Vercel, set `TELEGRAM_GROUP_CHAT_IDS` because serverless runtime storage is temporary.
Manual `Send news now` clicks have a 1-minute cooldown per group.

## HTTP Routes

```text
GET /health
GET /bot/status
GET /admin/news-config
GET /admin/groups
GET /admin/news-config/:chatId
POST /admin/news-config
POST /admin/news-stop
POST /admin/group-check
GET /admin/group-check/:chatId
POST /admin/group-test-message
POST /webhook/telegram
POST /webhook/telegram/set
GET /webhook/telegram/info
DELETE /webhook/telegram
POST /webhook/telegram/delete
GET /test/ping
POST /test/update
```

See `post-test.txt` for Talend/API-client test examples using the live URL.

HTTP bot-status, admin, test, and webhook-management routes are enabled when `TELEGRAM_ADMIN_CHAT_IDS` is set on the server. Talend does not need to send an admin header.
