CREATE TABLE IF NOT EXISTS tel_news_groups (
  chat_id VARCHAR(64) NOT NULL,
  topic VARCHAR(32) NULL,
  interval_minutes INT NULL,
  post_limit INT NULL,
  post_at VARCHAR(40) NULL,
  posts_sent INT NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  last_manual_post_at VARCHAR(40) NULL,
  last_scheduled_post_at VARCHAR(40) NULL,
  last_scheduled_attempt_at VARCHAR(40) NULL,
  updated_at VARCHAR(40) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id)
);

CREATE TABLE IF NOT EXISTS tel_news_chats (
  chat_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NULL,
  chat_type VARCHAR(32) NULL,
  username VARCHAR(255) NULL,
  source VARCHAR(32) NULL,
  updated_at VARCHAR(40) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id)
);

CREATE TABLE IF NOT EXISTS tel_news_posted (
  chat_id VARCHAR(64) NOT NULL,
  fingerprint VARCHAR(512) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, fingerprint)
);
