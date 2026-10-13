-- Leaderboard: pilots by experience (static/leaders.html, /api/leaders in app/profile.py)
CREATE INDEX player_stats_xp_idx ON player_stats (xp DESC, user_id);
