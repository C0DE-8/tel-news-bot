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
```

3. Start the bot:

```bash
cd backend
npm start
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
```

The bot stores group settings in `backend/data/groups.json`.

## HTTP Routes

```text
GET /health
GET /bot/status
```
