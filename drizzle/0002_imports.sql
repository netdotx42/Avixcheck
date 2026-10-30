ALTER TABLE "approved_charges" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approved_charges" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "committed_by" uuid;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_org_sha_idx" ON "import_batches" USING btree ("org_id","kind","file_sha256");