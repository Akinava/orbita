-- Accounts: pilots, their sign-in methods, e-mail confirmation, sessions and OAuth sign-ins in progress.

CREATE TABLE users (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email             text,                      -- lower case; NULL when a provider gave none
    email_verified_at timestamptz,               -- set by the confirmation letter or a provider that vouches for it
    password_hash     text,                      -- NULL for accounts that only sign in through providers
    display_name      text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_login_at     timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- One row per external account (Google, Apple, Discord, Meta) linked to a pilot
CREATE TABLE identities (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider   text NOT NULL,
    subject    text NOT NULL,                    -- the provider's user id
    email      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);
CREATE INDEX identities_user_id_idx ON identities (user_id);

-- Links from confirmation letters; only a hash of the token is stored
CREATE TABLE email_tokens (
    token_hash bytea PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose    text NOT NULL DEFAULT 'verify',
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_id_idx ON email_tokens (user_id);

-- Signed-in browsers; the cookie holds the token, the table its hash
CREATE TABLE sessions (
    token_hash   bytea PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    user_agent   text,
    ip           text
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- OAuth sign-ins between the redirect to the provider and its callback (state, PKCE verifier, nonce)
CREATE TABLE oauth_states (
    state      text PRIMARY KEY,
    provider   text NOT NULL,
    verifier   text NOT NULL,
    nonce      text NOT NULL,
    next_url   text NOT NULL DEFAULT '/',
    expires_at timestamptz NOT NULL
);
