/**
 * Shared helpers for confirming a MANUAL payment.
 *
 * Both merchant entry points must behave identically:
 *   * Orders page  → "تأكيد الدفع" on the order row.
 *   * Conversation / "بانتظار استكمال الدفع" page → "تأكيد الدفع" which also
 *     wakes the agent up again.
 *
 * In both cases the stock deduction is performed by the SAME DB function
 * (`confirm_order_payment`), which re-verifies the latest stock, deducts it
 * atomically and is idempotent, so a double click can never deduct twice.
 */

export interface ShortageLine {
  product_name?: string | null;
  color?: string | null;
  size?: string | null;
  requested?: number | null;
  available?: number | null;
}

export interface ConfirmationOutcome {
  orderNumber: string | null;
  ok: boolean;
  alreadyConfirmed?: boolean;
  error?: string;
  shortages?: ShortageLine[];
}

export interface ConfirmationSummary {
  ok: boolean;
  confirmed: number;
  alreadyConfirmed: number;
  error?: string;
  shortages: ShortageLine[];
  orderNumber: string | null;
}

/**
 * Pure roll-up of the per-order RPC results. A single failing order makes the
 * whole confirmation fail so the merchant is told BEFORE the agent resumes.
 */
export function summarizeConfirmations(results: ConfirmationOutcome[]): ConfirmationSummary {
  const list = results ?? [];
  const failed = list.find((r) => !r.ok);
  if (failed) {
    return {
      ok: false,
      confirmed: 0,
      alreadyConfirmed: 0,
      error: failed.error ?? "unknown",
      shortages: Array.isArray(failed.shortages) ? failed.shortages : [],
      orderNumber: failed.orderNumber ?? null,
    };
  }
  return {
    ok: true,
    confirmed: list.filter((r) => r.ok && !r.alreadyConfirmed).length,
    alreadyConfirmed: list.filter((r) => r.ok && r.alreadyConfirmed).length,
    shortages: [],
    orderNumber: null,
  };
}

/**
 * Turns a raw database error into a message the merchant can act on.
 *
 * A database that never received the offer-redemption helpers fails the whole
 * confirmation with "function public.record_order_offer_redemptions(...) does
 * not exist"; the remedy is to run the SQL file, so say that plainly instead of
 * showing the raw Postgres text.
 */
export function describeConfirmationError(message: string | null | undefined): string {
  const raw = String(message ?? "");
  if (raw.includes("record_order_offer_redemptions")) {
    return "قاعدة البيانات ناقصة دالة تسجيل العروض. شغّل الملف db/2026-09-04_restore_offer_redemption_fn.sql في محرر SQL ثم أعد تأكيد الدفع.";
  }
  return raw || "تعذّر تأكيد الدفع.";
}

/** Arabic one-liner for a shortage list (used in toasts). */
export function formatShortages(shortages: ShortageLine[]): string {
  return (shortages ?? [])
    .map((s) => {
      const label = [s.product_name, s.color, s.size].filter(Boolean).join(" - ");
      return `${label}: المطلوب ${s.requested ?? 0} / المتاح ${s.available ?? 0}`;
    })
    .join(" • ");
}

/**
 * Confirms every still-pending order attached to a conversation, deducting the
 * stock through `confirm_order_payment`. Orders that are already confirmed or
 * cancelled are skipped, so calling this repeatedly is safe.
 */
export async function confirmPendingOrdersForConversation(
  admin: any,
  opts: { conversationId: string; merchantId: string },
): Promise<ConfirmationSummary> {
  const { data: orders, error } = await admin
    .from("orders")
    .select("*")
    .eq("conversation_id", opts.conversationId)
    .eq("merchant_id", opts.merchantId);
  if (error) throw new Error(error.message);

  const { hasPendingAddition } = await import("@/lib/order-pending-additions");
  // Both an unpaid order AND a paid order carrying an unpaid ADDITION are
  // confirmed through the same RPC.
  const pending = ((orders ?? []) as any[]).filter(
    (o) =>
      o.status !== "cancelled" &&
      ((o.payment_status ?? "confirmed") === "pending" || hasPendingAddition(o)),
  );


  const results: ConfirmationOutcome[] = [];
  const confirmedIds: string[] = [];
  for (const o of pending) {
    const { data: res, error: rpcErr } = await admin.rpc("confirm_order_payment", {
      p_order_id: o.id,
      p_merchant_id: opts.merchantId,
    });
    if (rpcErr) throw new Error(describeConfirmationError(rpcErr.message));
    const r = (res ?? {}) as any;
    if (r.ok === false) {
      results.push({
        orderNumber: o.order_number ?? null,
        ok: false,
        error: String(r.error ?? "unknown"),
        shortages: Array.isArray(r.shortages) ? r.shortages : [],
      });
    } else {
      // Databases that record the redemption inside the same transaction as the
      // stock deduction need no second pass here.
      if (r.offers_handled !== true) confirmedIds.push(String(o.id));
      results.push({
        orderNumber: o.order_number ?? null,
        ok: true,
        alreadyConfirmed: Boolean(r.already_confirmed),
      });
    }
  }

  const summary = summarizeConfirmations(results);
  // Offers are counted ONLY here: after the payment is actually confirmed.
  if (summary.ok && confirmedIds.length) {
    const { recordOfferRedemptionsForOrders } = await import("@/lib/offer-redemptions.server");
    await recordOfferRedemptionsForOrders(admin, {
      merchantId: opts.merchantId,
      orderIds: confirmedIds,
    });
  }
  return summary;
}

