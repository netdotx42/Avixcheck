# Matching + checks engine

Deterministic code only. AI is used for extraction elsewhere; nothing here calls a model.

## Pipeline

1. **Documents module** finishes extraction (or a person saves a correction) and, in the same transaction,
   calls `enqueueMatch(tx, { orgId, invoiceId, revision })` from `src/modules/matching/service.ts`.
   It must have moved the invoice out of `extraction_review` first. Populate `invoices.supplier_tax_id_raw`
   when the document shows a tax/VAT id; it is the strongest supplier signal.
2. **`invoice.match`** (`runMatching`) resolves supplier → PO → PO lines → dated agreement with
   `matchInvoice()` (pure, `match.ts`) and stores the result in `invoices.match_result`.
   - A unique but weak candidate (confidence below `review.minMatchConfidence`) → invoice `matching_review`
     + one `matching_review` exception. Nothing is checked or billed until a person confirms with
     `confirmMatch()` (permission `invoice.edit`), which bumps the revision and enqueues the check.
   - Missing or conflicting references do not block: the check run turns them into
     `missing_reference` / `conflicting_reference` discrepancies, so the invoice can never pass.
3. **`invoice.check`** (`runCheck`) runs `evaluateInvoice()` (pure, `rules.ts`) inside one transaction.

## Check run guarantees

- Idempotency key `org:invoice.check:invoice:revision` is unique on `check_runs`; a retried job returns the committed run.
- Lock order invoice → purchase order → PO lines (by id). Concurrent checks on the same PO serialise on the PO row, so
  each sees the other's committed billings and a balance is never consumed twice.
- Prior completed runs → `superseded`; their `po_line_billings` → inactive; their open exceptions → `dismissed`
  ("Superseded by check run …") with the assignee carried to the same finding (type + line) in the new run.
  Decided exceptions are kept as history.
- `check_runs` stores `ruleSetVersion`, the org settings snapshot and a reference snapshot (supplier/PO versions,
  PO line quantities and prices, already-billed quantities, receipts, agreements with versions, approved charges,
  the match result).
- Terminal failures (permanent error or last attempt) set the invoice to `failed` with a `processing_failure`
  exception; retrying the job from Settings recovers it.

## Rules (`RULE_SET_VERSION` in `version.ts`)

| Type | Rule |
| --- | --- |
| `price_variance` | Unit price above agreement price (PO price when no agreement) beyond `tolerances.unitPrice`. Credit notes: credited below the expected price. Favourable prices are not flagged. |
| `missing_discount` | Agreement `discount_pct` applies (qty ≥ `min_quantity`) but the net price was not billed; a separate discount line covers shortfalls up to its value. |
| `quantity_excess` | Quantity above the PO line's remaining balance (ordered − active billings, incl. earlier lines of the same invoice) beyond `tolerances.quantity`. |
| `receipt_quantity_exceeded` | Only when receipts exist: quantity above received − billed. Exposure excludes what PO excess already counted. |
| `po_balance_exceeded` | Cumulative billed value above PO value, minus what line findings already explain. |
| `arithmetic_error` | qty × price vs line amount (`tolerances.lineAmount`, org rounding mode); lines vs subtotal; recomputed subtotal using `roundPerLine`; subtotal + tax vs total (`tolerances.invoiceTotal`). |
| `duplicate_invoice` | Same document, same supplier + normalised number, or same supplier + total + date (medium). Rejected invoices ignored. |
| `unapproved_charge` | Charge line with no approved charge of that type/currency on the date, or above `max_amount`. |
| `currency_mismatch` | Invoice vs PO (no conversion; PO price/balance comparisons skipped), agreement or supplier currency. |
| `unit_mismatch` | Invoice line unit vs PO line/agreement unit (synonyms like ea/each/pcs normalised). Line is not priced or billed. |
| `missing_reference` / `conflicting_reference` | Supplier, PO, PO line or agreement not found / ambiguous; closed or cancelled PO; cancelled PO line. |
| `missing_data` | Missing number, date, currency, total, lines, or line quantity / price / amount. |

`amount` on a discrepancy is **potential exposure** in invoice currency, never realised savings. Rules subtract
overlaps so exposure can be summed without double counting.

Credit notes are evaluated on absolute values and write negative billings, restoring PO balance.

## Helpers for other modules

- `requestRecheck(actor, invoiceId, expectedRevision)` / `recheckInvoiceAction` — `invoice.recheck`.
- `confirmMatch(actor, input)` / `confirmMatchAction` — `invoice.edit`, validates every id against the tenant.
- `releaseInvoiceBillings(tx, …)` — call when an invoice is rejected so it stops consuming PO balance.
- `poBalances(tx, poId)` — ordered / billed / remaining per PO line for the PO detail page.
