DROP INDEX "events_run_idx";--> statement-breakpoint
CREATE INDEX "runs_heartbeat_idx" ON "runs" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "tasks_claimed_by_run_idx" ON "tasks" USING btree ("claimed_by_run_id");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "events" USING btree ("run_id","created_at","seq");