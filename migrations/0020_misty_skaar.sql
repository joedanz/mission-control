DELETE FROM "tasks" WHERE "kind" = 'integration';--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_project_integration_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_project_label_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_claimable_idx";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "integration_type";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "integration_status";--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_label_uq" ON "tasks" USING btree ("project_id","label");--> statement-breakpoint
CREATE INDEX "tasks_claimable_idx" ON "tasks" USING btree ("sort_order","created_at") WHERE status = 'todo';
