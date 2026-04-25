CREATE TABLE "processed_signatures" (
	"signature" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
