-- Cross-tenant reference guard.
-- Foreign-key checks run without row-level security, so a plain FK lets org B
-- reference org A's row ids. Every tenant-to-tenant reference is checked here:
-- the referenced row must exist with the same org_id as the referencing row.
-- Arguments come in pairs: (column name, referenced table).
CREATE OR REPLACE FUNCTION enforce_same_org_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb := to_jsonb(NEW);
  i int := 0;
  col text;
  ref_table text;
  ref_id text;
  ok boolean;
BEGIN
  WHILE i < TG_NARGS LOOP
    col := TG_ARGV[i];
    ref_table := TG_ARGV[i + 1];
    ref_id := rec ->> col;
    IF ref_id IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1::uuid AND org_id = $2)', ref_table)
        INTO ok USING ref_id, NEW.org_id;
      IF NOT ok THEN
        RAISE EXCEPTION '%.% must reference a % row in the same organisation', TG_TABLE_NAME, col, ref_table
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS po_lines_same_org ON "po_lines";
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_lines_same_org ON "invoice_lines";
--> statement-breakpoint
DROP FUNCTION IF EXISTS po_lines_same_org();
--> statement-breakpoint
DROP FUNCTION IF EXISTS invoice_lines_same_org();
--> statement-breakpoint
CREATE TRIGGER "purchase_orders_same_org_refs" BEFORE INSERT OR UPDATE ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('supplier_id', 'suppliers');
--> statement-breakpoint
CREATE TRIGGER "po_lines_same_org_refs" BEFORE INSERT OR UPDATE ON "po_lines" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('po_id', 'purchase_orders');
--> statement-breakpoint
CREATE TRIGGER "po_revisions_same_org_refs" BEFORE INSERT OR UPDATE ON "po_revisions" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('po_id', 'purchase_orders');
--> statement-breakpoint
CREATE TRIGGER "price_agreements_same_org_refs" BEFORE INSERT OR UPDATE ON "price_agreements" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('supplier_id', 'suppliers');
--> statement-breakpoint
CREATE TRIGGER "approved_charges_same_org_refs" BEFORE INSERT OR UPDATE ON "approved_charges" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('supplier_id', 'suppliers');
--> statement-breakpoint
CREATE TRIGGER "receipts_same_org_refs" BEFORE INSERT OR UPDATE ON "receipts" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('po_line_id', 'po_lines');
--> statement-breakpoint
CREATE TRIGGER "import_rows_same_org_refs" BEFORE INSERT OR UPDATE ON "import_rows" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('batch_id', 'import_batches');
--> statement-breakpoint
CREATE TRIGGER "invoices_same_org_refs" BEFORE INSERT OR UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('document_id', 'documents', 'supplier_id', 'suppliers', 'purchase_order_id', 'purchase_orders', 'credits_invoice_id', 'invoices');
--> statement-breakpoint
CREATE TRIGGER "invoice_lines_same_org_refs" BEFORE INSERT OR UPDATE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('invoice_id', 'invoices', 'matched_po_line_id', 'po_lines', 'matched_agreement_id', 'price_agreements');
--> statement-breakpoint
CREATE TRIGGER "check_runs_same_org_refs" BEFORE INSERT OR UPDATE ON "check_runs" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('invoice_id', 'invoices');
--> statement-breakpoint
CREATE TRIGGER "discrepancies_same_org_refs" BEFORE INSERT OR UPDATE ON "discrepancies" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('check_run_id', 'check_runs', 'invoice_id', 'invoices', 'invoice_line_id', 'invoice_lines');
--> statement-breakpoint
CREATE TRIGGER "exceptions_same_org_refs" BEFORE INSERT OR UPDATE ON "exceptions" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('invoice_id', 'invoices', 'discrepancy_id', 'discrepancies');
--> statement-breakpoint
CREATE TRIGGER "po_line_billings_same_org_refs" BEFORE INSERT OR UPDATE ON "po_line_billings" FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs('po_line_id', 'po_lines', 'invoice_id', 'invoices', 'invoice_line_id', 'invoice_lines', 'check_run_id', 'check_runs');
