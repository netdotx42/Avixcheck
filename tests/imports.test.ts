import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser } from "./helpers";

setupTestEnv();
const { withTenant, withSystem } = await import("../src/db/tenant");
const schema = await import("../src/db/schema");
const { previewImport, commitImport, discardImport } = await import("../src/modules/imports/service");
const { TEMPLATES } = await import("../src/modules/imports/templates");
const { HANDLERS } = await import("../src/modules/imports/kinds");
const { IMPORT_KINDS } = await import("../src/modules/imports/types");
const { parseCsv } = await import("../src/modules/imports/csv");

type Actor = { userId: string; orgId: string; role: "admin" | "reviewer" | "viewer" };
const csv = (s: string) => new TextEncoder().encode(s);

async function rowsOf(orgId: string, batchId: string) {
  return withTenant(orgId, (tx) => tx.select().from(schema.importRows).where(eq(schema.importRows.batchId, batchId)).orderBy(schema.importRows.rowNumber));
}

async function importOk(actor: Actor, kind: Parameters<typeof previewImport>[1]["kind"], body: string, fileName = `${kind}.csv`) {
  const p = await previewImport(actor, { kind, fileName, bytes: csv(body) });
  if (p.errorCount) throw new Error(`preview errors: ${JSON.stringify((await rowsOf(actor.orgId, p.batchId)).filter((r) => (r.errors as unknown[]).length).map((r) => [r.rowNumber, r.errors]))}`);
  const c = await commitImport(actor, p.batchId);
  expect(c.status).toBe("committed");
  return { ...p, commit: c };
}

const SUPPLIERS = `supplier_code,name,tax_id,currency,aliases
SUP-001,Northwind Packaging Ltd,GB123456789,GBP,"Northwind Packaging;Northwind Pkg"
SUP-002,Contoso Metals,,EUR,
`;

describe("CSV templates", () => {
  it("are served exactly as the files in templates/csv and validate cleanly", () => {
    for (const kind of IMPORT_KINDS) {
      const file = readFileSync(path.join(__dirname, "..", "templates", "csv", `${kind}.csv`), "utf8");
      expect(TEMPLATES[kind]).toBe(file);
      const h = HANDLERS[kind];
      const header = file.split("\n")[0]!.split(",");
      expect(header).toEqual([...h.columns]);
      expect(parseCsv(csv(file), h.columns, h.required).every((r) => !r.parseErrors)).toBe(true);
    }
  });
});

describe("CSV parsing", () => {
  const h = { columns: ["a", "b"], required: ["a"] } as const;
  it("rejects files with unknown or missing columns, bad encoding, or no rows", () => {
    expect(() => parseCsv(csv("a,b,c\n1,2,3\n"), h.columns, h.required)).toThrow(/Unknown column/);
    expect(() => parseCsv(csv("b\n1\n"), h.columns, h.required)).toThrow(/Missing required/);
    expect(() => parseCsv(new Uint8Array([0xff, 0xfe, 0x41]), h.columns, h.required)).toThrow(/UTF-8/);
    expect(() => parseCsv(csv("a,b\n"), h.columns, h.required)).toThrow(/no data rows/);
    expect(() => parseCsv(csv("a,a\n1,2\n"), h.columns, h.required)).toThrow(/more than once/);
  });
  it("handles BOM, header case, whitespace and reports structural row errors", () => {
    const rows = parseCsv(csv("﻿ A ,B\n x , y \n1,2,3\n"), h.columns, h.required);
    expect(rows[0]).toEqual({ rowNumber: 2, data: { a: "x", b: "y" } });
    expect(rows[1]!.parseErrors?.[0]).toMatch(/Too many fields/);
  });
});

describe("imports", () => {
  let o: Awaited<ReturnType<typeof makeOrg>>;
  let actor: Actor;
  beforeAll(async () => {
    o = await makeOrg("Imports");
    actor = o.actor;
  });

  it("reports row-level validation errors and refuses to commit", async () => {
    const p = await previewImport(actor, {
      kind: "price_agreements",
      fileName: "bad.csv",
      bytes: csv(`agreement_ref,supplier_code,sku,description,unit_price,currency,unit,discount_pct,min_quantity,valid_from,valid_to
A1,NOPE,SKU1,,1.00,GBP,each,,,2026-01-01,
A1,NOPE,SKU1,,1.2345678,XXX,each,120,0,2026-02-30,2025-01-01
A1,NOPE,SKU1,,£1.00,gbp,,,,2026-01-01,
`),
    });
    expect(p.errorCount).toBe(3);
    const rows = await rowsOf(o.org.id, p.batchId);
    const errs = (n: number) => (rows.find((r) => r.rowNumber === n)!.errors as { field?: string; message: string }[]);
    expect(errs(2)).toEqual([{ field: "supplier_code", message: expect.stringMatching(/Unknown supplier_code/) }]);
    const fields3 = errs(3).map((e) => e.field).sort();
    expect(fields3).toEqual(["currency", "discount_pct", "min_quantity", "unit_price", "valid_from", "valid_to"].sort());
    expect(errs(3).find((e) => e.field === "unit_price")!.message).toMatch(/6 decimal places/);
    expect(errs(4).map((e) => e.field).sort()).toEqual(["unit", "unit_price"]);
    const c = await commitImport(actor, p.batchId);
    expect(c.status).toBe("blocked");
    const n = await withTenant(o.org.id, (tx) => tx.select().from(schema.priceAgreements));
    expect(n).toHaveLength(0);
  });

  it("imports suppliers, then updates and versions them; duplicate codes are row errors", async () => {
    const first = await importOk(actor, "suppliers", SUPPLIERS);
    expect(first.summary).toMatchObject({ create: 2, errors: 0 });
    const again = await importOk(actor, "suppliers", SUPPLIERS);
    expect(again.summary).toMatchObject({ unchanged: 2 });
    expect(again.previouslyCommittedBatchId).toBe(first.batchId);
    const upd = await importOk(actor, "suppliers", SUPPLIERS.replace("Contoso Metals", "Contoso Metals plc"));
    expect(upd.summary).toMatchObject({ unchanged: 1, update: 1 });
    const [s2] = await withTenant(o.org.id, (tx) => tx.select().from(schema.suppliers).where(eq(schema.suppliers.code, "SUP-002")));
    expect(s2).toMatchObject({ name: "Contoso Metals plc", version: 2, currency: "EUR", aliases: [] });

    const dup = await previewImport(actor, { kind: "suppliers", fileName: "dup.csv", bytes: csv("supplier_code,name\nX-1,One\nX-1,Two\n") });
    expect(dup.errorCount).toBe(1);
    const rows = await rowsOf(o.org.id, dup.batchId);
    expect((rows[1]!.errors as { message: string }[])[0]!.message).toMatch(/Duplicate supplier_code; also on row 2/);
  });

  it("flags overlapping agreements for the same supplier+sku+unit as conflicting", async () => {
    await importOk(actor, "price_agreements", `agreement_ref,supplier_code,sku,unit_price,currency,unit,valid_from,valid_to
AGR-1,SUP-001,BOX-12,0.42,GBP,each,2026-01-01,2026-06-30
AGR-1,SUP-001,BOX-12,0.45,GBP,each,2026-07-01,2026-12-31
`);
    // In-file overlap.
    const inFile = await previewImport(actor, {
      kind: "price_agreements",
      fileName: "overlap.csv",
      bytes: csv(`agreement_ref,supplier_code,sku,unit_price,currency,unit,valid_from,valid_to
AGR-9,SUP-002,X,1,EUR,each,2026-01-01,
AGR-9,SUP-002,X,2,EUR,each,2026-05-01,2026-06-01
`),
    });
    expect(inFile.errorCount).toBe(1);
    // Overlap with an existing agreement under a different reference.
    const vsDb = await previewImport(actor, {
      kind: "price_agreements",
      fileName: "conflict.csv",
      bytes: csv(`agreement_ref,supplier_code,sku,unit_price,currency,unit,valid_from,valid_to
AGR-2,SUP-001,BOX-12,0.40,GBP,each,2026-06-01,2026-08-31
AGR-2,SUP-001,BOX-12,0.40,GBP,box,2026-06-01,2026-08-31
`),
    });
    expect(vsDb.errorCount).toBe(1);
    const rows = await rowsOf(o.org.id, vsDb.batchId);
    const msgs = (rows[0]!.errors as { message: string }[]).map((e) => e.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatch(/Conflicting agreement: overlaps existing agreement AGR-1 v1/);
    expect(rows[1]!.errors).toEqual([]);
  });

  it("versions agreements instead of overwriting them", async () => {
    const r = await importOk(actor, "price_agreements", `agreement_ref,supplier_code,sku,unit_price,currency,unit,discount_pct,valid_from,valid_to
AGR-1,SUP-001,BOX-12,0.4100,GBP,each,2.5,2026-01-01,2026-12-31
`);
    expect(r.summary).toMatchObject({ new_version: 1, agreements_superseded: 2 });
    const all = await withTenant(o.org.id, (tx) => tx.select().from(schema.priceAgreements).where(eq(schema.priceAgreements.agreementRef, "AGR-1")).orderBy(schema.priceAgreements.version, schema.priceAgreements.validFrom));
    expect(all.map((a) => [a.version, a.unitPrice, a.supersededAt === null])).toEqual([
      [1, "0.420000", false],
      [1, "0.450000", false],
      [2, "0.410000", true],
    ]);
    // Re-importing identical terms (different number formatting) is a no-op.
    const same = await importOk(actor, "price_agreements", `agreement_ref,supplier_code,sku,unit_price,currency,unit,discount_pct,valid_from,valid_to
AGR-1,SUP-001,BOX-12,0.41,GBP,each,2.50,2026-01-01,2026-12-31
`);
    expect(same.summary).toMatchObject({ unchanged: 1 });
    const active = await withTenant(o.org.id, (tx) => tx.select().from(schema.priceAgreements).where(and(eq(schema.priceAgreements.agreementRef, "AGR-1"), isNull(schema.priceAgreements.supersededAt))));
    expect(active).toHaveLength(1);
  });

  it("versions approved charges and rejects overlapping charge periods", async () => {
    await importOk(actor, "approved_charges", "supplier_code,charge_type,max_amount,currency,valid_from,valid_to\nSUP-001,Freight,45.00,GBP,2026-01-01,\n");
    const r = await importOk(actor, "approved_charges", "supplier_code,charge_type,max_amount,currency,valid_from,valid_to\nSUP-001,freight,50,GBP,2026-01-01,\n");
    expect(r.summary).toMatchObject({ new_version: 1, charges_superseded: 1 });
    const rows = await withTenant(o.org.id, (tx) => tx.select().from(schema.approvedCharges).orderBy(schema.approvedCharges.version));
    expect(rows.map((c) => [c.chargeType, c.version, c.maxAmount, c.supersededAt === null])).toEqual([
      ["freight", 1, "45.0000", false],
      ["freight", 2, "50.0000", true],
    ]);
    const bad = await previewImport(actor, {
      kind: "approved_charges",
      fileName: "c.csv",
      bytes: csv("supplier_code,charge_type,max_amount,currency,valid_from,valid_to\nSUP-001,handling,,GBP,2026-01-01,2026-12-31\nSUP-001,handling,5,GBP,2026-03-01,\n"),
    });
    expect(bad.errorCount).toBe(1);
  });

  const PO = `po_number,supplier_code,currency,issued_on,line_no,sku,description,quantity,unit,unit_price
PO-1,SUP-001,GBP,2026-09-01,1,BOX-12,12in shipping box,1000,each,0.42
PO-1,SUP-001,GBP,2026-09-01,2,TAPE-48,48mm packing tape,200,roll,1.15
PO-1,SUP-001,GBP,2026-09-01,3,LBL,Labels,50,pack,3.00
`;

  it("rejects inconsistent PO headers and duplicate lines", async () => {
    const p = await previewImport(actor, {
      kind: "purchase_orders",
      fileName: "po-bad.csv",
      bytes: csv(`po_number,supplier_code,currency,issued_on,line_no,sku,description,quantity,unit,unit_price
PO-X,SUP-001,GBP,2026-09-01,1,,Thing,1,each,1
PO-X,SUP-001,EUR,2026-09-01,1,,Thing,0,each,1
`),
    });
    expect(p.errorCount).toBe(1);
    const rows = await rowsOf(o.org.id, p.batchId);
    expect((rows[1]!.errors as { field: string }[]).map((e) => e.field).sort()).toEqual(["quantity"]);
    // quantity fails schema, so header checks did not run for that row; fix it and re-check.
    const p2 = await previewImport(actor, { kind: "purchase_orders", fileName: "po-bad2.csv", bytes: csv(PO.replace("200,roll", "200,roll").replace("PO-1,SUP-001,GBP,2026-09-01,3", "PO-1,SUP-001,EUR,2026-09-01,2")) });
    const rows2 = await rowsOf(o.org.id, p2.batchId);
    expect((rows2[2]!.errors as { field: string }[]).map((e) => e.field).sort()).toEqual(["currency", "line_no"]);
  });

  it("creates POs, then amends them with revisions, versions and cancelled (not deleted) lines", async () => {
    const c = await importOk(actor, "purchase_orders", PO);
    expect(c.summary).toMatchObject({ create: 3 });
    const same = await importOk(actor, "purchase_orders", PO.replace("0.42", "0.420000"));
    expect(same.summary).toMatchObject({ unchanged: 3 });

    // Bill 400 boxes against line 1 (as the engine would) to protect it.
    await withTenant(o.org.id, async (tx) => {
      const [line] = await tx.select().from(schema.poLines).where(eq(schema.poLines.lineNo, 1));
      const [doc] = await tx.insert(schema.documents).values({ orgId: o.org.id, storageKey: `org/${o.org.id}/documents/t.pdf`, sha256: "x", sizeBytes: 1, mimeType: "application/pdf", originalName: "t.pdf" }).returning();
      const [inv] = await tx.insert(schema.invoices).values({ orgId: o.org.id, documentId: doc!.id }).returning();
      const [il] = await tx.insert(schema.invoiceLines).values({ orgId: o.org.id, invoiceId: inv!.id, lineNo: 1 }).returning();
      const [run] = await tx.insert(schema.checkRuns).values({ orgId: o.org.id, invoiceId: inv!.id, ruleSetVersion: "test", settingsSnapshot: {}, referenceSnapshot: {}, invoiceRevision: 1, idempotencyKey: "k" }).returning();
      await tx.insert(schema.poLineBillings).values({ orgId: o.org.id, poLineId: line!.id, invoiceId: inv!.id, invoiceLineId: il!.id, checkRunId: run!.id, quantity: "400", amount: "168" });
    });

    // Reducing line 1 below what is billed is an error.
    const below = await previewImport(actor, { kind: "purchase_orders", fileName: "po-below.csv", bytes: csv(PO.replace("1000,each", "300,each")) });
    expect(below.errorCount).toBe(1);
    expect(((await rowsOf(o.org.id, below.batchId))[0]!.errors as { message: string }[])[0]!.message).toMatch(/below the 400 already billed/);

    // Amend: line 1 qty 800, line 2 dropped (cancelled), line 3 unchanged, line 4 added.
    const amended = `po_number,supplier_code,currency,issued_on,line_no,sku,description,quantity,unit,unit_price
PO-1,SUP-001,GBP,2026-09-01,1,BOX-12,12in shipping box,800,each,0.42
PO-1,SUP-001,GBP,2026-09-01,3,LBL,Labels,50,pack,3.00
PO-1,SUP-001,GBP,2026-09-01,4,BAG,Bags,10,each,0.10
`;
    const a = await importOk(actor, "purchase_orders", amended);
    expect(a.summary).toMatchObject({ update_line: 1, unchanged: 1, add_line: 1, po_lines_cancelled: 1, pos_amended: 1 });
    const state = await withTenant(o.org.id, async (tx) => ({
      po: (await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.poNumber, "PO-1")))[0]!,
      lines: await tx.select().from(schema.poLines).orderBy(schema.poLines.lineNo),
      revs: await tx.select().from(schema.poRevisions),
    }));
    expect(state.po.version).toBe(2);
    expect(state.lines.map((l) => [l.lineNo, l.quantity, l.cancelled])).toEqual([
      [1, "800.0000", false],
      [2, "200.0000", true],
      [3, "50.0000", false],
      [4, "10.0000", false],
    ]);
    expect(state.revs).toHaveLength(1);
    expect(state.revs[0]!.version).toBe(1);
    const snap = state.revs[0]!.snapshot as { header: { version: number }; lines: { lineNo: number; quantity: string }[] };
    expect(snap.header.version).toBe(1);
    expect(snap.lines.find((l) => l.lineNo === 1)!.quantity).toBe("1000.0000");

    // Changing supplier or currency of an existing PO is refused.
    const cur = await previewImport(actor, { kind: "purchase_orders", fileName: "po-cur.csv", bytes: csv(amended.replaceAll("SUP-001,GBP", "SUP-002,EUR")) });
    const msgs = ((await rowsOf(o.org.id, cur.batchId))[0]!.errors as { message: string }[]).map((e) => e.message).join(" | ");
    expect(msgs).toMatch(/different supplier/);
    expect(msgs).toMatch(/currency cannot change/);
  });

  it("imports receipts; identical re-import is a no-op and conflicting values are errors", async () => {
    const body = "receipt_ref,po_number,line_no,quantity,received_on\nGRN-1,PO-1,1,600,2026-09-10\n";
    expect((await importOk(actor, "receipts", body)).summary).toMatchObject({ create: 1 });
    expect((await importOk(actor, "receipts", body.replace("600", "600.00"))).summary).toMatchObject({ unchanged: 1 });
    const bad = await previewImport(actor, {
      kind: "receipts",
      fileName: "r.csv",
      bytes: csv("receipt_ref,po_number,line_no,quantity,received_on\nGRN-1,PO-1,1,601,2026-09-10\nGRN-2,PO-1,2,1,2026-09-10\nGRN-3,PO-404,1,1,2026-09-10\nGRN-4,PO-1,9,1,2026-09-10\n"),
    });
    const rows = await rowsOf(o.org.id, bad.batchId);
    expect(rows.map((r) => (r.errors as { message: string }[])[0]?.message)).toEqual([
      expect.stringMatching(/already recorded for this line with quantity 600/),
      expect.stringMatching(/line 2 is cancelled/),
      expect.stringMatching(/Unknown PO "PO-404"/),
      expect.stringMatching(/has no line 9/),
    ]);
  });

  it("commit is idempotent: a second commit of the same batch is a no-op", async () => {
    const p = await previewImport(actor, { kind: "suppliers", fileName: "s3.csv", bytes: csv("supplier_code,name\nSUP-003,Third\n") });
    const [c1, c2] = await Promise.all([commitImport(actor, p.batchId), commitImport(actor, p.batchId)]);
    expect([c1.status, c2.status].sort()).toEqual(["already_committed", "committed"]);
    expect((await commitImport(actor, p.batchId)).status).toBe("already_committed");
    const n = await withTenant(o.org.id, (tx) => tx.select().from(schema.suppliers).where(eq(schema.suppliers.code, "SUP-003")));
    expect(n).toHaveLength(1);
    const events = await withTenant(o.org.id, (tx) => tx.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entityId, p.batchId))));
    expect(events.map((e) => e.action).sort()).toEqual(["import.committed", "import.previewed"]);
  });

  it("two batches creating the same records concurrently do not duplicate them", async () => {
    const body = "supplier_code,name\nSUP-C1,Concurrent One\n";
    const p1 = await previewImport(actor, { kind: "suppliers", fileName: "c1.csv", bytes: csv(body) });
    const p2 = await previewImport(actor, { kind: "suppliers", fileName: "c2.csv", bytes: csv(body) });
    const [r1, r2] = await Promise.all([commitImport(actor, p1.batchId), commitImport(actor, p2.batchId)]);
    expect([r1.status, r2.status]).toEqual(["committed", "committed"]);
    expect([r1.summary.create ?? 0, r2.summary.create ?? 0].sort()).toEqual([0, 1]);
    const n = await withTenant(o.org.id, (tx) => tx.select().from(schema.suppliers).where(eq(schema.suppliers.code, "SUP-C1")));
    expect(n).toHaveLength(1);
  });

  it("re-validates at commit time and blocks when reference data changed since preview", async () => {
    const p = await previewImport(actor, { kind: "price_agreements", fileName: "late.csv", bytes: csv("agreement_ref,supplier_code,sku,unit_price,currency,unit,valid_from\nAGR-L,SUP-003,Z,1,GBP,each,2026-01-01\n") });
    expect(p.errorCount).toBe(0);
    await withTenant(o.org.id, (tx) => tx.update(schema.suppliers).set({ active: false }).where(eq(schema.suppliers.code, "SUP-003")));
    const c = await commitImport(actor, p.batchId);
    expect(c.status).toBe("blocked");
    expect(((await rowsOf(o.org.id, p.batchId))[0]!.errors as { message: string }[])[0]!.message).toMatch(/inactive/);
  });

  it("discard only applies to previews", async () => {
    const p = await previewImport(actor, { kind: "suppliers", fileName: "d.csv", bytes: csv("supplier_code,name\nSUP-D,D\n") });
    await discardImport(actor, p.batchId);
    await expect(commitImport(actor, p.batchId)).rejects.toThrow(/discarded/);
    await expect(discardImport(actor, p.batchId)).rejects.toThrow(/Only an import in preview/);
  });
});

describe("import permissions and tenant isolation", () => {
  it("only admins can preview, commit or discard", async () => {
    const { org, actor } = await makeOrg("ImpPerm");
    const reviewer = await makeUser("rev");
    await withSystem((tx) => tx.insert(schema.memberships).values({ orgId: org.id, userId: reviewer.id, role: "reviewer" }));
    const p = await previewImport(actor, { kind: "suppliers", fileName: "s.csv", bytes: csv("supplier_code,name\nA,B\n") });
    for (const role of ["reviewer", "viewer"] as const) {
      const a = { userId: reviewer.id, orgId: org.id, role };
      await expect(previewImport(a, { kind: "suppliers", fileName: "s.csv", bytes: csv("supplier_code,name\nA,B\n") })).rejects.toThrow(/reference.import/);
      await expect(commitImport(a, p.batchId)).rejects.toThrow(/reference.import/);
      await expect(discardImport(a, p.batchId)).rejects.toThrow(/reference.import/);
    }
  });

  it("cannot see, commit or reference another organisation's data", async () => {
    const a = await makeOrg("ImpA");
    const b = await makeOrg("ImpB");
    await importOk(a.actor, "suppliers", "supplier_code,name\nSHARED,Alpha only\n");
    const pa = await previewImport(a.actor, { kind: "suppliers", fileName: "x.csv", bytes: csv("supplier_code,name\nA2,Alpha two\n") });
    // B cannot commit A's batch: RLS hides it.
    await expect(commitImport(b.actor, pa.batchId)).rejects.toThrow(/not found/);
    // A supplier code that exists only in A is unknown to B.
    const pb = await previewImport(b.actor, { kind: "price_agreements", fileName: "y.csv", bytes: csv("agreement_ref,supplier_code,sku,unit_price,currency,unit,valid_from\nR,SHARED,S,1,GBP,each,2026-01-01\n") });
    expect(pb.errorCount).toBe(1);
    // B's own supplier with the same code is independent.
    await importOk(b.actor, "suppliers", "supplier_code,name\nSHARED,Beta copy\n");
    const seenByB = await withTenant(b.org.id, (tx) => tx.select().from(schema.suppliers));
    expect(seenByB.map((s) => s.name)).toEqual(["Beta copy"]);
    const batchesSeenByB = await withTenant(b.org.id, (tx) => tx.select().from(schema.importBatches).where(eq(schema.importBatches.id, pa.batchId)));
    expect(batchesSeenByB).toHaveLength(0);
    const rowsSeenByB = await withTenant(b.org.id, (tx) => tx.execute(sql`select count(*)::int as n from import_rows where batch_id = ${pa.batchId}`));
    expect((rowsSeenByB.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("reference read models", () => {
  it("computes PO billed and remaining from active billings only, with credit notes reducing them", async () => {
    const { getPurchaseOrder, listPurchaseOrders, listAgreements } = await import("../src/modules/imports/queries");
    const { org, actor } = await makeOrg("Balances");
    await importOk(actor, "suppliers", "supplier_code,name\nS,Supplier\n");
    await importOk(actor, "purchase_orders", "po_number,supplier_code,currency,issued_on,line_no,sku,description,quantity,unit,unit_price\nPO-B,S,GBP,2026-09-01,1,A,Item A,10,each,1.105\nPO-B,S,GBP,2026-09-01,2,B,Item B,3,each,0.333333\n");
    const poId = await withTenant(org.id, async (tx) => {
      const [po] = await tx.select().from(schema.purchaseOrders);
      const [line] = await tx.select().from(schema.poLines).where(eq(schema.poLines.lineNo, 1));
      const [doc] = await tx.insert(schema.documents).values({ orgId: org.id, storageKey: `org/${org.id}/documents/b.pdf`, sha256: "b", sizeBytes: 1, mimeType: "application/pdf", originalName: "b.pdf" }).returning();
      const [inv] = await tx.insert(schema.invoices).values({ orgId: org.id, documentId: doc!.id }).returning();
      const [il] = await tx.insert(schema.invoiceLines).values({ orgId: org.id, invoiceId: inv!.id, lineNo: 1 }).returning();
      const run = async (key: string) => (await tx.insert(schema.checkRuns).values({ orgId: org.id, invoiceId: inv!.id, ruleSetVersion: "t", settingsSnapshot: {}, referenceSnapshot: {}, invoiceRevision: 1, idempotencyKey: key }).returning())[0]!;
      const r1 = await run("r1");
      const r2 = await run("r2");
      const r3 = await run("r3");
      // Superseded run (inactive) must not count; current invoice 6 units; credit note -2 units.
      await tx.insert(schema.poLineBillings).values([
        { orgId: org.id, poLineId: line!.id, invoiceId: inv!.id, invoiceLineId: il!.id, checkRunId: r1.id, quantity: "6", amount: "6.63", active: false },
        { orgId: org.id, poLineId: line!.id, invoiceId: inv!.id, invoiceLineId: il!.id, checkRunId: r2.id, quantity: "6", amount: "6.63" },
        { orgId: org.id, poLineId: line!.id, invoiceId: inv!.id, invoiceLineId: il!.id, checkRunId: r3.id, quantity: "-2", amount: "-2.21" },
      ]);
      return po!.id;
    });
    const po = await withTenant(org.id, (tx) => getPurchaseOrder(tx, poId));
    const l1 = po!.lines.find((l) => l.line.lineNo === 1)!;
    expect([l1.orderedAmount, l1.billedQty, l1.billedAmount, l1.remainingQty, l1.remainingAmount]).toEqual(["11.05", "4", "4.42", "6", "6.63"]);
    // 11.05 + 3 * 0.333333 = 12.049999 exactly (no float drift).
    expect(po!.totals).toEqual({ ordered: "12.049999", billed: "4.42", remaining: "7.629999" });
    const list = await withTenant(org.id, (tx) => listPurchaseOrders(tx, { page: 1 }));
    expect(list.rows[0]).toMatchObject({ ordered: "12.049999", billed: "4.42", remaining: "7.629999", lines: 2 });
    const searchMiss = await withTenant(org.id, (tx) => listPurchaseOrders(tx, { q: "%", page: 1 }));
    expect(searchMiss.total).toBe(0);
    const ag = await withTenant(org.id, (tx) => listAgreements(tx, { page: 1 }));
    expect(ag.total).toBe(0);
  });
});
