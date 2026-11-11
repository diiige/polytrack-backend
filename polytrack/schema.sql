DROP TABLE IF EXISTS scores;
CREATE TABLE scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_token_hash TEXT NOT NULL,
  nickname TEXT,
  country_code TEXT,
  car_style TEXT,
  track_id TEXT NOT NULL,
  frames INTEGER NOT NULL,
  recording TEXT,
  only_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_scores_track_frames ON scores(track_id, frames);
CREATE INDEX idx_scores_token_hash ON scores(user_token_hash);
