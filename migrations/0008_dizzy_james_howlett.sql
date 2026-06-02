CREATE TABLE "agent_profiles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"runtime" text DEFAULT 'claude-code' NOT NULL,
	"model" text,
	"provider" text,
	"base_url" text,
	"permission_mode" text,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mcp_servers" jsonb,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disallowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"append_system_prompt" text,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"exec_template" text,
	"match_rules" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_profile_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_slug_uq" ON "agent_profiles" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_default_uq" ON "agent_profiles" USING btree ("is_default") WHERE is_default;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Scoped-role grant for the new table (the runs column is covered by the existing table-level runs grant,
-- and USAGE ON SCHEMA public was granted in 0004). Guarded + idempotent like 0002/0004; handles BOTH the
-- current role name (mc_agent) and the legacy one (cc_agent) so it's correct whether or not a given DB has
-- had the cc→mc rename (0007_rename_cc_agent_role) applied. No-ops on a DB where the role doesn't exist yet.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_profiles" TO mc_agent;
  ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_profiles" TO cc_agent;
  END IF;
END $$;