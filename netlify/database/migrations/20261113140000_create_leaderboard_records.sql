CREATE TABLE leaderboard_records (
  id SERIAL PRIMARY KEY,
  track_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  country_code TEXT,
  car_style TEXT NOT NULL,
  frames INTEGER NOT NULL,
  recording TEXT NOT NULL,
  replay_boost_settings JSONB,
  replay_boost_timeline JSONB,
  normal_physics_confirmed BOOLEAN,
  verified_state INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX leaderboard_track_user_unique ON leaderboard_records (track_id, user_id);
