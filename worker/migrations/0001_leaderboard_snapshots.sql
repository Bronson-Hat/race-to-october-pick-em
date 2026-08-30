CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  snapshot_date TEXT NOT NULL,
  player_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  standing_balance INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, player_id)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_player_date
  ON leaderboard_snapshots (player_id, snapshot_date DESC);
