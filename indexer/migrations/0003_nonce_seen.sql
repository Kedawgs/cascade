-- keys.unexplained_tx keeps a running count of each watched address's transactions seen in Cascade's
-- logs (plan Task 16), added as the tick stores them, so no tick counts the txs table (a busy keeper would
-- make that thousands of rows a minute). baseline is then the transactions the logs never explained:
-- those before watching began, and the ones already alerted. (No semicolons in comments.)
ALTER TABLE nonces ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;
