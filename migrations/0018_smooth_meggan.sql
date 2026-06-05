ALTER TABLE "mcp_connections" ALTER COLUMN "toolkit_slug" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_connections" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "remote_name" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "remote_url" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "remote_headers" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_project_remote_uq" ON "mcp_connections" USING btree ("project_id","remote_name") WHERE source = 'remote';