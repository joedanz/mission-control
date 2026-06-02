ALTER TABLE "tasks" ADD COLUMN "claimed_by_run_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_claimed_by_run_id_runs_id_fk" FOREIGN KEY ("claimed_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Phase 2 claim columns (claimed_by_run_id / claimed_at / claim_expires_at) live on `tasks`; a
-- table-level UPDATE grant covers added columns automatically. Re-assert the cc_agent grant here
-- (guarded so it no-ops on a DB without the role) — the original projects/tasks grant is a manual
-- README step, not in any migration, so this is belt-and-suspenders for the scoped agent role.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tasks" TO cc_agent;
  END IF;
END $$;