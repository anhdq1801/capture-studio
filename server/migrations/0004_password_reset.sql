-- Password reset.
--
-- Until now an account whose password was forgotten was simply lost, along with everything
-- uploaded under it: /auth/signup and /auth/login were the whole of the auth surface.

-- Only the SHA-256 of the token is stored. The token itself goes out in one email and is never
-- written down here, so a leak of this table cannot be replayed into a password change.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  -- Set the moment the token is spent, so a link forwarded, cached or sitting in a mail
  -- provider's link-scanner cannot be used a second time.
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

-- Sessions issued before a password change have to stop working, or resetting after a laptop
-- is stolen changes the password and leaves the thief's 30-day token valid. JWTs here carry no
-- id to revoke, so `requireAuth` compares their `iat` against this instead.
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
