-- M6: re-apply the agent-role grants with a DUAL-NAME guard (mc_agent OR cc_agent).
--
-- The grant migrations 0001 (runs/events), 0002 (tasks), and 0004 (projects + schema USAGE) guard ONLY on
-- the legacy `cc_agent` role. The role is now `mc_agent`, so on a database rebuilt purely from
-- `drizzle-kit migrate` (a fresh Neon branch, DR, new staging — exactly what 0004's own header says it
-- exists to fix), those three blocks no-op: mc_agent ends up with NO `USAGE ON SCHEMA public` and NO grants
-- on projects/tasks/runs/events, so every `mc` command fails with permission denied. (Later grant
-- migrations — 0008, 0015, 0016 — already check both names; only the three early ones were missed.)
--
-- This migration re-applies the full set with the same dual-name DO-block pattern. GRANT is idempotent, so
-- re-running on a DB that already has them (the current prod/dev instance) is a safe no-op. mc_agent takes
-- the scope README documents: projects + tasks read/write incl. DELETE; runs + events read/write WITHOUT
-- DELETE (append/update-only audit + telemetry).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mc_agent') THEN
    GRANT USAGE ON SCHEMA public TO mc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "projects" TO mc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tasks" TO mc_agent;
    GRANT SELECT, INSERT, UPDATE ON "runs" TO mc_agent;
    GRANT SELECT, INSERT, UPDATE ON "events" TO mc_agent;
  ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    GRANT USAGE ON SCHEMA public TO cc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "projects" TO cc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tasks" TO cc_agent;
    GRANT SELECT, INSERT, UPDATE ON "runs" TO cc_agent;
    GRANT SELECT, INSERT, UPDATE ON "events" TO cc_agent;
  END IF;
END $$;
