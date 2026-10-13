-- Leaderboard by flight time (static/leaders.html?by=flight, /api/leaders in app/profile.py)
CREATE INDEX player_stats_flight_idx ON player_stats (flight_seconds DESC, user_id);
