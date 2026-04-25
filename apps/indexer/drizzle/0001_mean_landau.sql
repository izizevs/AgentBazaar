ALTER TABLE "service_listings" ADD COLUMN "capability" text;--> statement-breakpoint
ALTER TABLE "service_listings" ADD COLUMN "reputation_score" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_listings" ADD COLUMN "endpoint" text;