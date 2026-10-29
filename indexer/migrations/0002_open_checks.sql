-- The delivery checks still open, loaded by every tick (plan Task 14): without an index on status that
-- query reads every check ever made. (No semicolons in comments: migrations are split on them.)
CREATE INDEX batch_checks_by_status ON batch_checks(status);
