/**
 * CSV templates served at /api/import-templates/<kind>. These must stay identical
 * to templates/csv/*.csv (a test enforces it); the files are what people edit.
 */
import type { ImportKind } from "./types";

export const TEMPLATES: Record<ImportKind, string> = {
  suppliers: "supplier_code,name,tax_id,currency,aliases\nSUP-001,Northwind Packaging Ltd,GB123456789,GBP,\"Northwind Packaging;Northwind Pkg\"\n",
  purchase_orders: "po_number,supplier_code,currency,issued_on,line_no,sku,description,quantity,unit,unit_price\nPO-10001,SUP-001,GBP,2026-09-01,1,BOX-12,12in shipping box,1000,each,0.420000\nPO-10001,SUP-001,GBP,2026-09-01,2,TAPE-48,48mm packing tape,200,roll,1.150000\n",
  price_agreements: "agreement_ref,supplier_code,sku,description,unit_price,currency,unit,discount_pct,min_quantity,valid_from,valid_to\nAGR-2026-01,SUP-001,BOX-12,12in shipping box,0.420000,GBP,each,2.5,500,2026-01-01,2026-12-31\n",
  approved_charges: "supplier_code,charge_type,max_amount,currency,valid_from,valid_to\nSUP-001,freight,45.00,GBP,2026-01-01,\n",
  receipts: "receipt_ref,po_number,line_no,quantity,received_on\nGRN-5001,PO-10001,1,600,2026-09-10\n",
};
