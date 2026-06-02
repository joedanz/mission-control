ALTER TABLE "events" ALTER COLUMN "tokens" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "cost_micros" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "tokens_in" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "tokens_out" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "cache_read_tokens" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "cache_write_tokens" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "cost_micros" SET DATA TYPE bigint;