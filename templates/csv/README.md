# CSV import templates

Download these from the app (Suppliers & Agreements or Purchase Orders, "template" buttons) or use the files here. Import them at **Imports** (Admins only). Every upload is validated row by row and shown as a preview; nothing is saved until an Admin commits it, and a preview with any row error cannot be committed.

General rules

- UTF-8 CSV with a header row. Column names are case-insensitive; column order does not matter. Unknown columns are rejected. Optional columns may be left out or left blank.
- Limits: 1.9 MB and 20,000 rows per file.
- Numbers are plain decimals (`1250.50`), no currency symbols, thousands separators or exponents. Values with more decimal places than the column allows are rejected, never rounded.
- Dates are `YYYY-MM-DD`. Date ranges are inclusive; a blank `valid_to` means open-ended.
- Currencies are ISO 4217 codes (`GBP`, `EUR`, `USD`).
- Import in this order: suppliers, then purchase orders, price agreements and approved charges, then receipts. Rows that refer to an unknown supplier or PO are errors.
- Re-importing the same data is safe: unchanged rows are reported as "No change" and nothing is written.

## suppliers.csv

| Column | Required | Notes |
| --- | --- | --- |
| supplier_code | yes | Your unique code. Existing codes are updated (version + 1). |
| name | yes | |
| tax_id | no | VAT / tax number, used for invoice matching. |
| currency | no | Default currency. |
| aliases | no | Other names printed on invoices, separated by `;`. |

## purchase_orders.csv

One row per PO line; repeat the PO header columns on every line.

| Column | Required | Notes |
| --- | --- | --- |
| po_number | yes | |
| supplier_code | yes | Must exist. Cannot change for an existing PO. |
| currency | yes | Cannot change for an existing PO. |
| issued_on | no | |
| line_no | yes | Whole number, unique within the PO. |
| sku | no | |
| description | yes | |
| quantity | yes | Greater than 0, up to 4 decimal places. |
| unit | yes | e.g. `each`, `box`, `kg`. Cannot change on a line that has been billed. |
| unit_price | yes | Up to 6 decimal places. |

A PO in the file is treated as the complete PO. Importing a changed PO **amends** it: the previous version is kept as a snapshot, the version number goes up, and lines missing from the file are marked **cancelled** (never deleted). A line's quantity cannot be reduced below what has already been billed. Closed or cancelled POs cannot be amended.

## price_agreements.csv

| Column | Required | Notes |
| --- | --- | --- |
| agreement_ref | yes | Your contract or price-list reference. |
| supplier_code | yes | Must exist and be active. |
| sku | yes | |
| description | no | |
| unit_price | yes | Up to 6 decimal places. |
| currency | yes | |
| unit | yes | Price is per this unit. |
| discount_pct | no | 0 to <100, e.g. `2.5` for 2.5%. Blank = 0. |
| min_quantity | no | Quantity at which the discount applies. |
| valid_from | yes | |
| valid_to | no | |

An agreement line is identified by supplier + agreement_ref + sku + unit. The rows in the file for a line replace its current terms: if anything differs, the old rows are marked superseded and the new rows get the next version number. Old versions stay stored so earlier checks remain explainable. Two agreements for the same supplier, SKU and unit with overlapping dates are rejected as **conflicting**, whatever their agreement_ref.

## approved_charges.csv

| Column | Required | Notes |
| --- | --- | --- |
| supplier_code | yes | |
| charge_type | yes | e.g. `freight`, `handling`. Stored in lower case. |
| max_amount | no | Maximum per invoice. Blank = no cap. |
| currency | yes | |
| valid_from | yes | |
| valid_to | no | |

Versioned like agreements (by supplier + charge_type + currency). Overlapping periods for the same charge are rejected.

## receipts.csv

| Column | Required | Notes |
| --- | --- | --- |
| receipt_ref | yes | Goods receipt / delivery note number. |
| po_number | yes | Must exist. |
| line_no | yes | Must exist and not be cancelled. |
| quantity | yes | Greater than 0. |
| received_on | yes | |

Receipts are facts: importing an identical receipt again does nothing; importing the same receipt with different values is an error. Receipt-quantity checks only run for PO lines that have receipts.
