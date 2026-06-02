DROP INDEX "tasks_claimable_idx";--> statement-breakpoint
CREATE INDEX "tasks_claimable_idx" ON "tasks" USING btree ("sort_order","created_at") WHERE status = 'todo' and kind = 'custom';