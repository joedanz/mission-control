-- Make the cc_agent grants on `projects` + the schema USAGE migration-driven. Until now these two lived
-- ONLY as a manual psql step in README.md, so a DB rebuilt purely from `drizzle-kit migrate` (a new Neon
-- branch, DR, fresh staging) left cc_agent unable to even resolve a slug — `tasks`/`runs`/`events` are
-- already migration-granted (0002 / 0001), but `projects` and `USAGE ON SCHEMA public` were not.
-- Guarded by a pg_roles check so the migration no-ops on a DB where the role doesn't exist yet (the
-- role is still created by hand once, per README — these grants then apply on every later migrate). GRANT
-- is idempotent, so re-running on a DB that already has them (e.g. the current prod==dev instance) is safe.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    GRANT USAGE ON SCHEMA public TO cc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "projects" TO cc_agent;
  END IF;
END $$;
