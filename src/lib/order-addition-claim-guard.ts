/**
 * ADDITION CLAIM GUARD.
 *
 * A customer who adds a piece to an order they already have must go through the
 * exact same registration path as the first order: `create_order` writes the
 * addition, the merchant's payment flow decides whether it is paid or waits for
 * a manual confirmation, the orders screen shows it, and a notification is
 * raised.
 *
 * The failure this guards against is purely conversational: the model answers
 * "تمام، ضفتها لحضرتك، المطلوب كذا" WITHOUT ever calling `create_order`. Nothing
 * is written, no "تأكيد الدفع" button appears, no notification arrives, and the
 * agent keeps chatting because no manual-payment handover was triggered.
 *
 * So whenever the conversation already has an order and the turn ends with no
 * order tool call, the reply is judged by MEANING (never by keywords) and, if it
 * claims an addition happened, the model is corrected and forced to actually
 * register it.
 *
 * Pure helpers — no I/O, fully testable.
 */

export interface AdditionClaimCheckInput {
  /** The conversation already carries at least one registered order. */
  hasExistingOrder: boolean;
  /** `create_order` succeeded during THIS turn. */
  orderRegisteredThisTurn: boolean;
  /** How many corrections were already issued in this turn. */
  correctionsIssued: number;
  /** The reply the model wants to send. */
  reply: string;
}

/** Only worth spending a judgement call when an unregistered claim is possible. */
export function shouldJudgeAdditionClaim(input: AdditionClaimCheckInput): boolean {
  if (!input.hasExistingOrder) return false;
  if (input.orderRegisteredThisTurn) return false;
  if (input.correctionsIssued >= 1) return false;
  return Boolean(input.reply && input.reply.trim().length > 0);
}

/** Judgement prompt: meaning only, one word out. */
export function buildAdditionClaimJudgeMessages(
  reply: string,
  customerText: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You judge one reply written by a store representative to a customer who already has a registered order. " +
        "Answer YES when the reply tells the customer, in any wording, that an extra product or an extra quantity " +
        "has been added / adjusted / set on their existing order, or asks them to pay for such an addition, or states " +
        "the amount due for it. Answer NO when the reply only discusses, offers, explains or asks for confirmation " +
        "without presenting the addition as done or as payable. Answer with exactly YES or NO.",
    },
    {
      role: "user",
      content: `Customer said: ${customerText}\n\nRepresentative reply: ${reply}`,
    },
  ];
}

/** Reads the judge's answer; anything unclear is treated as "no claim". */
export function parseAdditionClaimVerdict(raw: string | null | undefined): boolean {
  return /^\s*yes\b/i.test(String(raw ?? ""));
}

/**
 * Correction pushed back into the model context. It does not write the reply —
 * it forces the registration path so the real payment flow runs.
 */
export const ADDITION_CLAIM_CORRECTION =
  "SYSTEM CORRECTION — NOTHING WAS SAVED. Your draft reply tells the customer that an addition to their existing " +
  "order is done or payable, but you never called create_order, so no addition exists, the store sees nothing, and " +
  "no payment step was started. Adding to an order is NEVER just a sentence. Call create_order NOW for the SAME " +
  "existing order, sending the NEW TOTAL quantity of each affected line (already recorded 1 + one extra = 2), with " +
  "the payment method the customer actually chose. Then write your reply ONLY from the tool result: what was added, " +
  "the amount due for the addition alone, and the payment instructions it returns. If the customer has not chosen a " +
  "payment method yet, ask them for it and promise nothing else.";

