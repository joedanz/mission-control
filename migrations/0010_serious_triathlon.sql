ALTER TABLE "agent_profiles" ADD COLUMN "schedule_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "schedule_project_id" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "schedule_interval_sec" integer;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "schedule_cron" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "check_in_prompt" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "last_check_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_schedule_project_id_projects_id_fk" FOREIGN KEY ("schedule_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_profiles_schedulable_idx" ON "agent_profiles" USING btree ("schedule_enabled") WHERE schedule_enabled;