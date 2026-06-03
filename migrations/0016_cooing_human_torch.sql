CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"graph_snapshot" jsonb NOT NULL,
	"context" jsonb,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_step_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_id" text,
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"graph" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_status_idx" ON "workflow_runs" USING btree ("workflow_id","status");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_heartbeat_idx" ON "workflow_runs" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_runs_run_node_uq" ON "workflow_step_runs" USING btree ("workflow_run_id","node_id");--> statement-breakpoint
CREATE INDEX "workflow_step_runs_run_idx" ON "workflow_step_runs" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_slug_uq" ON "workflows" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workflows_project_idx" ON "workflows" USING btree ("project_id");--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workflows" TO mc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_runs" TO mc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_step_runs" TO mc_agent;
  ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workflows" TO cc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_runs" TO cc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_step_runs" TO cc_agent;
  END IF;
END $$;