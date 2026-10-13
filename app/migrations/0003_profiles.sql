-- Pilot profiles: the statistics the game servers count (app/stats.py) and avatars.

CREATE TABLE player_stats (
    user_id        bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    xp             bigint NOT NULL DEFAULT 0,
    flight_seconds double precision NOT NULL DEFAULT 0,  -- time flying: in space, alive, not docked
    pvp_kills      integer NOT NULL DEFAULT 0,            -- pilots shot down
    pirate_kills   integer NOT NULL DEFAULT 0,
    asteroid_kills integer NOT NULL DEFAULT 0,
    deaths         integer NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Kept apart from users so that reading a pilot does not load the picture
CREATE TABLE avatars (
    user_id      bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    content_type text NOT NULL,
    data         bytea NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
