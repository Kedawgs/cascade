-- The owner's approvals of delivery checks (pnpm checks:approve), found each tick by their time
-- (checks.owner_approved, plan Task 24): only approved rows are in this index, so the tick reads only those.
-- (No semicolons in comments.)
CREATE INDEX batch_checks_approved ON batch_checks(approved_at) WHERE approved_at IS NOT NULL;
