-- Leaderboard by victories, pilots and pirates shot down together (static/leaders.html?by=wins). The
-- expression must stay the same as in /api/leaders (app/profile.py) for the index to be used.
CREATE INDEX player_stats_wins_idx ON player_stats ((pvp_kills + pirate_kills) DESC, user_id);
