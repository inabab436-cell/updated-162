/**
 * ACTIVE ORDER STATE — structured, database-derived state of the order the
 * customer is currently building (or already placed) in this conversation.
 *
 * Purpose: the agent must NOT re-derive the order facts by re-reading chat
 * text. It reads them from this block. Any field that carries a value here is
 * CONFIRMED and must never be asked about again; only the fields listed under
 * "الحقول الناقصة فقط" may be asked for.
 *
 * Pure function — no network, no database, no environment access. Callers pass
 * already-loaded rows (customers row + the conversation's latest order row).
 */

export interface ActiveOrderStateInput {
  customer?: {
    name?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;
  /** Latest order row of this conversation, if one exists. */
  order?: {
    order_number?: string | null;
    status?: string | null;
    payment_method?: string | null;
    payment_status?: string | null;
    items?: unknown;
  } | null;
  /**
   * The selection the customer already settled on in this conversation, read
 * from the PERSISTED structured order state (`conversations.order_state`),
 * not re-derived from the transcript. Used only to fill fields the order row
 * does not carry yet; a real order row always wins. Selection values may still
 * be provisional; `stageLines` tells the model whether customer confirmation
 * actually exists.
   */
  selection?: {
    product_name?: string | null;
    color?: string | null;
    size?: string | null;
    quantity?: string | null;
    payment_method?: string | null;
  } | null;
  /** Shipping zone already resolved for this conversation, when known. */
  shippingZone?: string | null;
  /** Per-field stage lines (extracted / verified / confirmed / committed). */
  stageLines?: string[] | null;
  /**
   * Availability directive produced by the pre-order check. Only ever set
   * while the order is still being built; never after an order row exists.
   */
  availabilityNote?: string | null;
}



export const ACTIVE_ORDER_STATE_HEADING = "ACTIVE ORDER STATE";

const UNKNOWN = "غير معروف";

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "-" || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

function firstItem(items: unknown): Record<string, unknown> | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = items[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

function quantityOf(item: Record<string, unknown> | null): string | null {
  if (!item) return null;
  const q = item.quantity;
  if (typeof q === "number" && Number.isFinite(q) && q > 0) return String(q);
  const parsed = clean(q);
  return parsed && /^\d+$/.test(parsed) && Number(parsed) > 0 ? parsed : null;
}

/**
 * Renders the ACTIVE ORDER STATE block. Returns a string that always starts
 * with the ALL-CAPS heading so the reply sanitizer can strip it if it ever
 * leaks into an assistant reply.
 */
export function buildActiveOrderStateBlock(input: ActiveOrderStateInput): string {
  const item = firstItem(input.order?.items);
  const sel = input.selection ?? null;
  const selQuantity = (() => {
    const q = clean(sel?.quantity);
    return q && /^\d+$/.test(q) && Number(q) > 0 ? q : null;
  })();

  const fields: Array<{ key: string; label: string; value: string | null }> = [
    { key: "الاسم", label: "الاسم", value: clean(input.customer?.name) },
    { key: "الموبايل", label: "الموبايل", value: clean(input.customer?.phone) },
    { key: "العنوان", label: "العنوان", value: clean(input.customer?.address) },
    {
      key: "المنتج",
      label: "المنتج",
      value: clean(item?.product_name) ?? clean(sel?.product_name),
    },
    { key: "اللون", label: "اللون", value: clean(item?.color) ?? clean(sel?.color) },
    { key: "المقاس", label: "المقاس", value: clean(item?.size) ?? clean(sel?.size) },
    { key: "الكمية", label: "الكمية", value: quantityOf(item) ?? selQuantity },
    {
      key: "طريقة الدفع",
      label: "طريقة الدفع",
      value: clean(input.order?.payment_method) ?? clean(sel?.payment_method),
    },
  ];


  const byKey = new Map(fields.map((f) => [f.key, f.value]));
  const show = (key: string) => byKey.get(key) ?? UNKNOWN;

  const missing = fields.filter((f) => !f.value).map((f) => f.key);

  const lines: string[] = [
    ACTIVE_ORDER_STATE_HEADING,
    `الاسم: ${show("الاسم")}`,
    `الموبايل: ${show("الموبايل")}`,
    `العنوان: ${show("العنوان")}`,
    `المنتج: ${show("المنتج")} | اللون: ${show("اللون")} | المقاس: ${show("المقاس")} | الكمية: ${show("الكمية")}`,
    `طريقة الدفع: ${show("طريقة الدفع")}`,
  ];

  const shippingZone = clean(input.shippingZone);
  if (shippingZone) lines.push(`منطقة الشحن المحسومة: ${shippingZone}`);

  const stageLines = (input.stageLines ?? []).filter((l) => typeof l === "string" && l.trim());
  if (stageLines.length) {
    lines.push("مراحل البيانات (مبدئي → متحقق → مؤكَّد → منفَّذ):");
    for (const l of stageLines) lines.push(`- ${l}`);
    lines.push(
      "«مبدئي» فرضية مستخرجة وليست دليلاً أن العميل اختارها أو أكدها. «متحقق» يعني أن القيمة موجودة في المتجر فقط، وليس أن العميل اختارها. لا تنسب أي قيمة للعميل ولا تقل إنه قالها أو اتكلم عنها أو إنك فاكرها إلا إذا كانت «مؤكَّد» أو «منفَّذ». «منفَّذ» مسجَّل في الطلب فعلياً ولا يتغيّر.",
    );
  }

  const orderNumber = clean(input.order?.order_number);
  if (orderNumber) {
    lines.push(
      `رقم الطلب المسجَّل: ${orderNumber} | الحالة: ${clean(input.order?.status) ?? UNKNOWN}`,
    );
    const paid = String(input.order?.payment_status ?? "confirmed") !== "pending";
    lines.push(
      paid
        ? "حالة الدفع للجزء المسجَّل حالياً: مؤكَّدة — لا تطلب دفع أو إثبات تحويل عن هذا الجزء تحديداً. هذا لا يشمل أي إضافة جديدة: أي قطعة أو منتج يُضاف بعد ذلك جزء جديد غير مدفوع وله مسار دفع كامل مستقل (اختيار طريقة الدفع → تسجيل الإضافة بالأداة → تعليمات الدفع)."
        : "حالة الدفع: لم يتم تأكيد الدفع بعد.",
    );
    lines.push(
      "الطلب أُنشئ بنجاح بهذه البيانات بعد التحقق منها، ومرحلة جمع البيانات انتهت. لا تعيد جمع أي بيان ولا تعيد فتح أي خطوة سابقة. إذا طلب العميل إضافة قطعة أو منتج، افحص الإضافة وحدها من المخزون الحالي، ثم سجّلها فعلياً باستدعاء أداة create_order على نفس رقم الطلب بالكمية الإجمالية الجديدة للسطر وطريقة الدفع التي اختارها العميل؛ لا تعتبر الكمية الموجودة في الطلب جزءاً من المخزون الحالي ولا تنشئ طلباً جديداً.",
      "ممنوع نهائياً أن تقول إن الإضافة تمت أو تذكر مبلغها المطلوب قبل أن تستدعي create_order وتقرأ نتيجتها؛ الكلام وحده لا يسجّل شيئاً ولا يُظهر زر تأكيد الدفع للتاجر.",
    );

  } else {
    const availability = clean(input.availabilityNote);
    if (availability) {
      lines.push(
        "تنبيه توافر (قبل إنشاء الطلب — عالجه الآن قبل الانتقال للخطوة التالية): " + availability,
      );
    }
  }

  lines.push(
    `الحقول الناقصة فقط: [${missing.join("، ")}]`,
    "اسأل عن الحقول الناقصة عند الحاجة للخطوة التالية. الحقل ذو المرحلة «مؤكَّد» أو «منفَّذ» فقط هو اختيار محسوم من العميل ولا يُسأل عنه مجدداً. الحقل «مبدئي» أو «متحقق» لا يجوز تقديمه كاختيار أو ذكرى للعميل؛ استخدمه كاحتمال داخلي فقط واسأل سؤال تأكيد قصيراً عند الحاجة.",
  );

  return lines.join("\n");

}
