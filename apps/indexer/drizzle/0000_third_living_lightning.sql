CREATE TABLE "service_listings" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"capability_hash" "bytea" NOT NULL,
	"sati_agent_id" bigint NOT NULL,
	"price_lamports" bigint NOT NULL,
	"pricing_model" integer NOT NULL,
	"sla_params" jsonb NOT NULL,
	"metadata_uri" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"jobs_completed" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_service_listings_capability_hash" ON "service_listings" USING btree ("capability_hash");--> statement-breakpoint
CREATE INDEX "idx_service_listings_discover" ON "service_listings" USING btree ("capability_hash","is_active","price_lamports");