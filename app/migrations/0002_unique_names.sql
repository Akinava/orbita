-- Pilot names belong to accounts: unique regardless of case, so nobody else can fly under them in
-- multiplayer. Earlier duplicates keep the oldest owner; the others get their id appended.

UPDATE users u
SET display_name = left(u.display_name, 15 - length(u.id::text)) || '-' || u.id
WHERE EXISTS (
    SELECT 1 FROM users o WHERE lower(o.display_name) = lower(u.display_name) AND o.id < u.id
);

CREATE UNIQUE INDEX users_display_name_key ON users (lower(display_name));
