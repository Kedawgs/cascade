-- Every stored delivery (vault BatchDelivered) and landing (front door PayoutsDelivered) gets its check row,
-- waiting, in the same statements that store its log (store.ts upsertLogs), so none can miss its cross-check
-- whatever its block (review of Tasks 11-20, C1). A batch check records where its delivery came from (only
-- our front door on Base counts toward a duplicate) and when it was first seen (bridge.check_stuck times
-- a check from it when the delivery's block time is never fetched). (No semicolons in comments.)
ALTER TABLE batch_checks ADD COLUMN source_chain INTEGER;
ALTER TABLE batch_checks ADD COLUMN front_door TEXT;
ALTER TABLE batch_checks ADD COLUMN first_seen INTEGER;

-- the anti-join, once: rows for any delivery or landing stored before this migration
INSERT OR IGNORE INTO batch_checks (batch_id, delivered_key, delivered_uid, delivered_tx, status, source_chain, front_door)
  SELECT CAST(json_extract(args, '$.batchId') AS INTEGER), json_extract(args, '$.key'), uid, tx_hash, 'waiting',
         CAST(json_extract(args, '$.sourceChain') AS INTEGER), json_extract(args, '$.frontDoor')
  FROM logs WHERE chain = 'bittensor' AND contract = 'vault' AND event = 'BatchDelivered' AND removed = 0;
INSERT OR IGNORE INTO chunk_checks (landed_uid, batch_key, chunk, landed_tx, landed_block, status)
  SELECT uid, json_extract(args, '$.batchKey'), json_extract(args, '$.chunk'), tx_hash, block, 'waiting'
  FROM logs WHERE chain = 'base' AND contract = 'frontDoor' AND event = 'PayoutsDelivered' AND removed = 0;
