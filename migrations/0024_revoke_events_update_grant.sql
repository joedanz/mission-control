-- LT5 (audit): `events` is an append-only audit log — recordEvent/createEvent only INSERT, and createEvent's
-- idempotency uses ON CONFLICT DO NOTHING (not DO UPDATE). Migrations 0001/0023 granted the scoped agent role
-- UPDATE on events alongside runs (runs legitimately needs UPDATE for heartbeats/run-end; events does not).
-- Revoke it to match the documented design and the principle of least privilege. Idempotent (REVOKE of a
-- privilege the role doesn't hold is a no-op). Separate IF blocks so BOTH role names are covered if present.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mc_agent') THEN
    REVOKE UPDATE ON "events" FROM mc_agent;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    REVOKE UPDATE ON "events" FROM cc_agent;
  END IF;
END $$;
