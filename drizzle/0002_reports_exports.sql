ALTER TABLE "exports" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "error" text;--> statement-breakpoint
CREATE INDEX "exports_expiry_idx" ON "exports" USING btree ("status","expires_at");