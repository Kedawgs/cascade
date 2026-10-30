-- A watched address read as a Safe (by its nonce()) stays a Safe (the polish review, item 4): a tick that
-- misreads its code, and so has no nonce(), skips it instead of judging it by its transaction count, which
-- would reset its baseline and page a false keys.unexplained_tx when the nonce() comes back. (No semicolons
-- in comments.)
ALTER TABLE nonces ADD COLUMN safe INTEGER NOT NULL DEFAULT 0;
