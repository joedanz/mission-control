-- Cost-aware routing (Slice 4): per-profile overload fallback + a same-UTC-day spend cap that triggers a
-- downgrade to the fallback model. Both new columns are covered by the existing table-level agent_profiles
-- grant (0008), so no additional GRANT is required.
ALTER TABLE "agent_profiles" ADD COLUMN "fallback_model" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "daily_budget_micros" bigint;