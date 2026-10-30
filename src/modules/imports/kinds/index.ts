import type { ImportKind, KindHandler } from "../types";
import { approvedChargesImport } from "./approved-charges";
import { priceAgreementsImport } from "./price-agreements";
import { purchaseOrdersImport } from "./purchase-orders";
import { receiptsImport } from "./receipts";
import { suppliersImport } from "./suppliers";

export const HANDLERS: Record<ImportKind, KindHandler> = {
  suppliers: suppliersImport,
  purchase_orders: purchaseOrdersImport,
  price_agreements: priceAgreementsImport,
  approved_charges: approvedChargesImport,
  receipts: receiptsImport,
};
