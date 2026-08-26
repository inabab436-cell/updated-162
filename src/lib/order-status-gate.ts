/**
 * Single source of truth for the "no fulfilment before payment" rule.
 *
 * An order can only move to prepared / shipped / delivered after its payment
 * has been confirmed (payment_status !== 'pending').
 */
export const PAYMENT_REQUIRED_MESSAGE =
  "لا يمكن بدء تنفيذ الطلب قبل تأكيد الدفع، لضمان عدم تجهيز أو شحن طلب غير مدفوع.";

export function isOrderPaid(paymentStatus: string | null | undefined): boolean {
  return String(paymentStatus ?? "confirmed") !== "pending";
}

export function canStartFulfillment(paymentStatus: string | null | undefined): boolean {
  return isOrderPaid(paymentStatus);
}

export const PENDING_ADDITION_MESSAGE =
  "الطلب يحتوي على إضافة لم يتم تأكيد دفعها بعد. أكّد دفع الإضافة أولاً قبل التجهيز أو الشحن.";

/**
 * Whole-order gate: an order that carries an unpaid ADDITION cannot start
 * fulfilment either, even though its original part is already paid.
 */
export function canStartFulfillmentForOrder(order: {
  payment_status?: string | null;
  status?: string | null;
  pending_items?: unknown;
}): { ok: boolean; message?: string } {
  if (!isOrderPaid(order?.payment_status)) {
    return { ok: false, message: PAYMENT_REQUIRED_MESSAGE };
  }
  const pending = Array.isArray(order?.pending_items) ? order.pending_items : [];
  const hasPending = pending.some(
    (it) => Number((it as Record<string, unknown>)?.["quantity"] ?? 0) > 0,
  );
  if (hasPending) return { ok: false, message: PENDING_ADDITION_MESSAGE };
  return { ok: true };
}
