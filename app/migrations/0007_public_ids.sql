-- Public pilot ids: profile links, leaderboards and avatar URLs show this random id instead of users.id,
-- so pilots cannot be listed by counting ids and the number of accounts does not show.
-- gen_random_uuid() is built in from PostgreSQL 13; existing pilots get one each.
ALTER TABLE users ADD COLUMN public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid();
