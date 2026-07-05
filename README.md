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
TELEGRAM_ADMIN_CHAT_IDS=your_telegram_user_id
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

## Telegram Commands

Use these commands inside the group where the bot was added:

```text
/setnews crypto
/setnews politics
/news
/status
/setinterval 30
/stopnews
/adminpanel
/adminid
```

The bot stores group settings in `backend/data/groups.json`.

If `TELEGRAM_ADMIN_CHAT_IDS` is set, only those Telegram users can change settings or force posts.
Use `/adminid` in Telegram to see your user id and the current chat id. Use `/adminpanel` to manage the bot with buttons.

## HTTP Routes

```text
GET /health
GET /bot/status
GET /admin/news-config
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

See `post-test.txt` for curl examples.
