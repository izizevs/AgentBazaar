CREATE TABLE "agent_reputation" (
	"wallet" text PRIMARY KEY NOT NULL,
	"jobs_completed" bigint DEFAULT 0 NOT NULL,
	"avg_score" smallint DEFAULT 0 NOT NULL,
	"total_score" bigint DEFAULT 0 NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrows" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"buyer" text NOT NULL,
	"seller" text NOT NULL,
	"listing" text NOT NULL,
	"vault" text NOT NULL,
	"amount_usdc" bigint NOT NULL,
	"sla_params" jsonb NOT NULL,
	"state" text NOT NULL,
	"result_uri" text,
	"result_hash" "bytea",
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"escrow_pubkey" text NOT NULL,
	"severity" text NOT NULL,
	"refund_pct" smallint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_escrows_seller_state" ON "escrows" USING btree ("seller","state");--> statement-breakpoint
CREATE INDEX "idx_escrows_buyer_state" ON "escrows" USING btree ("buyer","state");--> statement-breakpoint
CREATE INDEX "idx_sla_reports_escrow_pubkey" ON "sla_reports" USING btree ("escrow_pubkey");