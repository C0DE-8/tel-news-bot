CREATE TABLE IF NOT EXISTS tel_news_storage_checks (
  check_id VARCHAR(96) NOT NULL,
  checked_at VARCHAR(40) NOT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (check_id)
);
