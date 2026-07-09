# tel-news-bot

A Telegram bot that posts real news into Telegram groups or channels on a schedule. Each chat can choose the type of news it wants:

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
TELEGRAM_GROUP_CHAT_IDS=-1002195390106|Liberty forward
# DBMS Gateway
SITE_ID=your_project_site_id
API_KEY=full_dbms_api_key_not_the_short_prefix
DBMS_URL=https://api.dbms.copupbid.com/api
DBMS_TIMEOUT_MS=15000
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
📊 Status
⏳ Timer
🚀 Send news now
🛠 Admin panel
🪪 Admin ID
📰 Set news
✅ Select multiple chats
✅ Check chat
🧪 Test
▶️ Start
⏸ Stop
⬅️ Back
🏠 Main menu
📋 List configs
```

The bot stores chat settings, known chats, and posted-news fingerprints in real SQL tables: `tel_news_groups`, `tel_news_chats`, and `tel_news_posted`. The app creates those tables automatically; `backend/migrations/002_create_normalized_news_tables.sql` is the migration for manual setup/debugging. The old `tel_news_data` JSON table is no longer used by the bot.
Database gateway access is centralized in `backend/db.js`, which uses the local `backend/diamond-sql.js` connector. Do not store MySQL host, user, or password in this app; keep real MySQL credentials only in the DBMS Gateway project.
The connector accepts either `https://api.dbms.copupbid.com/api` or `https://api.dbms.copupbid.com` and tries the supported gateway paths automatically.

If `TELEGRAM_ADMIN_CHAT_IDS` is set, only those Telegram users can change settings or force posts.
Use the `Admin panel` button to manage the bot. The panel has an `Admin ID` button if you need your Telegram user id.
The picker shows channels/groups from `TELEGRAM_GROUP_CHAT_IDS` plus chats the bot has seen while running. On Vercel, set `TELEGRAM_GROUP_CHAT_IDS` because serverless runtime storage is temporary.
Use `Select multiple` in the admin panel to apply one topic, interval, and limit to more than one group/channel from Telegram buttons.
When an admin saves news settings, the bot writes to SQL first, reads the saved row back, verifies the values, then schedules or posts from that saved database config.
Manual `Send news now` clicks have a 10-second cooldown per group/channel.
Scheduled posting is handled by in-app timers. The bot reads saved SQL config, starts timers for enabled chats, and posts when each saved interval is reached.
Status responses include `schedule.nextPostAt`, `schedule.nextPostInSeconds`, and `schedule.countdown` so you can see when the next post should happen.
Admin controls and posting feedback go to the private admin chat. Channels/groups only receive news posts and test messages.
If a group or channel message contains a code like `LF-IPC-CIVIC-XXXXAABBCC`, the bot replies with `https://zephyrequi.com is the investment site.` For channels, the Telegram webhook must allow `channel_post`.

## HTTP Routes

```text
GET /health
GET /version
GET /bot/status
GET /admin/news-config
GET /admin/groups
GET /admin/storage-check
POST /admin/storage-check
GET /admin/news-config/:chatId
POST /admin/news-config
POST /admin/news-start
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
