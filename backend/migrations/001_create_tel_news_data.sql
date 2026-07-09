CREATE TABLE IF NOT EXISTS tel_news_data (
  data_name VARCHAR(32) NOT NULL,
  data_json LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (data_name),
  CONSTRAINT tel_news_data_json_valid CHECK (JSON_VALID(data_json))
);

INSERT INTO tel_news_data (data_name, data_json)
VALUES
  ('groups', '{}'),
  ('chats', '{}'),
  ('posted', '{}')
ON DUPLICATE KEY UPDATE data_name = VALUES(data_name);
