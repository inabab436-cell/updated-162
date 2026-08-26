export interface MergeableOrderItem {
  product_name?: string | null;
  color?: string | null;
  size?: string | null;
  quantity?: number | null;
  [key: string]: unknown;
}

function norm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[يى]/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function sameLine(a: MergeableOrderItem, b: MergeableOrderItem): boolean {
  return (
    norm(a.product_name) === norm(b.product_name) &&
    norm(a.color) === norm(b.color) &&
    norm(a.size) === norm(b.size)
  );
}

/**
 * Applies the customer's newly requested TOTALS to an existing order basket.
 * Existing lines not mentioned in the request are retained unchanged; a new
 * variant is appended. This is deliberately separate from stock delta logic:
 * the order row stores the complete basket while stock receives only the delta.
 */
export function mergeOrderItemTotals<T extends MergeableOrderItem>(
  existingItems: T[],
  requestedTotals: T[],
): T[] {
  const merged = (existingItems ?? []).map((item) => ({ ...item }));
  for (const requested of requestedTotals ?? []) {
    const index = merged.findIndex((item) => sameLine(item, requested));
    if (index >= 0) {
      merged[index] = { ...merged[index], ...requested };
    } else {
      merged.push({ ...requested });
    }
  }
  return merged;
}

/**
 * SUMS the quantities (and line totals) of two baskets instead of replacing
 * them. Used for an unpaid ADDITION on a paid order: the caller passes the
 * quantity that is genuinely new, which must be added on top of whatever is
 * already registered as pending.
 */
export function addOrderItemQuantities<T extends MergeableOrderItem>(
  existingItems: T[],
  addedItems: T[],
): T[] {
  const merged = (existingItems ?? []).map((item) => ({ ...item }));
  for (const added of addedItems ?? []) {
    const index = merged.findIndex((item) => sameLine(item, added));
    const addedQty = Number(added.quantity ?? 0);
    if (index >= 0) {
      const current = merged[index]!;
      const currentQty = Number(current.quantity ?? 0);
      const currentTotal = Number((current as Record<string, unknown>)["line_total"] ?? 0);
      const addedTotal = Number((added as Record<string, unknown>)["line_total"] ?? 0);
      merged[index] = {
        ...current,
        ...added,
        quantity: (Number.isFinite(currentQty) ? currentQty : 0) + (Number.isFinite(addedQty) ? addedQty : 0),
        line_total:
          (Number.isFinite(currentTotal) ? currentTotal : 0) +
          (Number.isFinite(addedTotal) ? addedTotal : 0),
      } as T;
    } else {
      merged.push({ ...added });
    }
  }
  return merged;
}
