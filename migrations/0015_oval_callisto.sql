CREATE TABLE "composio_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"toolkit_slug" text NOT NULL,
	"user_id" text NOT NULL,
	"connected_account_id" text,
	"status" text DEFAULT 'initializing' NOT NULL,
	"link_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composio_toolkits" (
	"slug" text PRIMARY KEY NOT NULL,
	"auth_config_id" text,
	"mcp_server_id" text,
	"mcp_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "composio_connections" ADD CONSTRAINT "composio_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "composio_connections_project_toolkit_uq" ON "composio_connections" USING btree ("project_id","toolkit_slug");--> statement-breakpoint
CREATE INDEX "composio_connections_project_idx" ON "composio_connections" USING btree ("project_id");--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_toolkits" TO mc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_connections" TO mc_agent;
  ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_toolkits" TO cc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_connections" TO cc_agent;
  END IF;
END $$;