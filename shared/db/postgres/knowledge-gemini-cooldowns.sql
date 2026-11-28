CREATE TABLE IF NOT EXISTS navigation.knowledge_gemini_cooldowns (
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  strikes INTEGER NOT NULL,
  PRIMARY KEY (user_id, model)
);
