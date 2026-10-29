-- When the monitor first saw a payout landing's check (re-review of Tasks 11-20, I1): bridge.check_stuck
-- times a landing still waiting, or awaiting its delivered() read, from its block time, or from this when
-- that block time is never fetched or the landing's log isn't loaded. On Base a forged payout is claimable
-- at once, so no landing may wait unseen. (No semicolons in comments.)
ALTER TABLE chunk_checks ADD COLUMN first_seen INTEGER;
