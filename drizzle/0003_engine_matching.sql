ALTER TABLE "invoices" ADD COLUMN "supplier_tax_id_raw" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "match_result" jsonb;