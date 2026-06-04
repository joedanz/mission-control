ALTER TABLE "composio_connections" RENAME TO "mcp_connections";--> statement-breakpoint
ALTER TABLE "mcp_connections" RENAME CONSTRAINT "composio_connections_project_id_projects_id_fk" TO "mcp_connections_project_id_projects_id_fk";--> statement-breakpoint
ALTER INDEX "composio_connections_project_toolkit_uq" RENAME TO "mcp_connections_project_toolkit_uq";--> statement-breakpoint
ALTER INDEX "composio_connections_project_idx" RENAME TO "mcp_connections_project_idx";--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "source" text DEFAULT 'composio' NOT NULL;
