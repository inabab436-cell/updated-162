/**
 * UNPAID ADDITIONS ON A PAID ORDER.
 *
 * An order whose payment was already confirmed keeps its confirmed part frozen
 * (`items` + `subtotal_price` / `discount_amount` / `total_price`). Anything the
 * customer adds afterwards is stored separately on the SAME order row as
 * `pending_items` + `pending_subtotal` / `pending_discount` / `pending_total`
 * and is NOT paid, NOT discounted retroactively and NOT deducted from stock
 * until the merchant confirms it through `confirm_order_payment`.
 *
 * Pure helpers — safe on both client and server.
 */
import { subtractAlreadyDeducted, type DeltaItem } from "@/lib/order-quantity-delta";

export interface PendingAdditionRow {
  payment_status?: string | null;
  status?: string | null;
  pending_items?: unknown;
  pending_subtotal?: unknown;
  pending_discount?: unknown;
  pending_total?: unknown;
  pending_since?: unknown;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The lines of the addition that is still waiting for its own payment. */
export function pendingItemsOf(order: PendingAdditionRow | null | undefined): Array<Record<string, unknown>> {
  const items = order?.pending_items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

/** True when this order carries an addition that has NOT been paid yet. */
export function hasPendingAddition(order: PendingAdditionRow | null | undefined): boolean {
  if (!order) return false;
  if (String(order.status ?? "").toLowerCase() === "cancelled") return false;
  return pendingItemsOf(order).some((it) => num(it?.["quantity"]) > 0);
}

export interface PendingTotals {
  subtotal: number;
  discount: number;
  total: number;
}

/** Amounts of the unpaid addition only (never mixed with the paid part). */
export function pendingTotalsOf(order: PendingAdditionRow | null | undefined): PendingTotals {
  return {
    subtotal: num(order?.pending_subtotal),
    discount: num(order?.pending_discount),
    total: num(order?.pending_total),
  };
}

/**
 * True when the order still needs a payment confirmation — either the whole
 * order is unpaid, or a later addition is.
 */
export function awaitsPaymentConfirmation(order: PendingAdditionRow | null | undefined): boolean {
  if (!order) return false;
  if (String(order.status ?? "").toLowerCase() === "cancelled") return false;
  if (String(order.payment_status ?? "confirmed") === "pending") return true;
  return hasPendingAddition(order);
}

/**
 * Removes the quantities that are ALREADY recorded as a pending addition, so a
 * customer restating the same total never registers the same addition twice.
 * The pending lines are not deducted from stock, hence the separate pass from
 * `subtractAlreadyDeducted`.
 */
export function subtractPendingQuantities<T extends DeltaItem>(
  requestedItems: T[],
  pendingItems: Array<Record<string, unknown>>,
): { items: T[]; allAlreadyPending: boolean } {
  const pending = (pendingItems ?? []).filter((it) => num(it?.["quantity"]) > 0);
  if (!pending.length) {
    return { items: requestedItems ?? [], allAlreadyPending: false };
  }
  const res = subtractAlreadyDeducted(requestedItems ?? [], [
    // A synthetic "deducted" row: the pairing logic is identical, only the
    // meaning differs (already registered instead of already deducted).
    { status: "new", items: pending, stock_deducted: [{ quantity: 1 }] },
  ]);
  return { items: res.items, allAlreadyPending: res.allAlreadyDeducted };
}

/** Arabic one-liner describing the unpaid addition (UI + agent context). */
export function describePendingAddition(
  order: PendingAdditionRow | null | undefined,
  currency = "",
): string | null {
  if (!hasPendingAddition(order)) return null;
  const lines = pendingItemsOf(order)
    .filter((it) => num(it["quantity"]) > 0)
    .map((it) => {
      const label = [it["product_name"], it["color"], it["size"]].filter(Boolean).join(" - ");
      return `${label} × ${num(it["quantity"])}`;
    })
    .join("، ");
  const { total } = pendingTotalsOf(order);
  return `إضافة بانتظار تأكيد الدفع: ${lines} — ${total} ${currency}`.trim();
}
