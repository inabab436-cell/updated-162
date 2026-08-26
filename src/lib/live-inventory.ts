/**
 * LIVE INVENTORY LOOKUP — the agent's on-demand read of the merchant's
 * knowledge base (the ONLY source of truth for products).
 *
 * The turn snapshot is built once per customer message, but stock can move
 * between the snapshot and the moment the agent actually writes a sentence
 * about a product (merchant edits, a parallel order, a restock). This module
 * shapes a freshly re-read catalogue into a compact, unambiguous answer the
 * model can quote verbatim: which colours/sizes really have stock RIGHT NOW,
 * which ran out, and the exact quantity of each line.
 *
 * Pure: no network, no database. The caller re-reads the catalogue.
 */

import { normKey } from "@/lib/order-catalog-match";

export interface LiveVariant {
  color?: string | null;
  size?: string | null;
  stock?: number | null;
  price?: number | null;
}

export interface LiveProduct {
  id?: string | null;
  name?: string | null;
  price?: number | null;
  variants?: LiveVariant[] | null;
}

export interface LiveInventoryLine {
  color: string | null;
  size: string | null;
  quantity: number;
  price: number | null;
}

export interface LiveInventoryProduct {
  product_id: string;
  product_name: string;
  total_quantity: number;
  status: "in_stock" | "sold_out";
  in_stock: LiveInventoryLine[];
  sold_out: Array<{ color: string | null; size: string | null }>;
}

export interface LiveInventoryQuery {
  product_id?: string | null;
  product_name?: string | null;
}

/**
 * Name matching is EXACT or containment only — never similarity.
 *
 * A misspelled or near-miss word ("تيشيرت" for "تيشرت") must NOT be forced
 * onto a catalogue product: resolving it would be a guess, and the model
 * would then treat the guessed product as the customer's established intent.
 * A miss degrades to the full live catalogue plus the unresolved rule, so
 * the model resolves the reference from the conversation itself or asks the
 * customer one short clarification question.
 */
function matchesQuery(product: LiveProduct, query: LiveInventoryQuery): boolean {
  const id = String(query.product_id ?? "").trim();
  if (id) return String(product.id ?? "") === id;
  const key = normKey(query.product_name);
  if (!key) return true;
  const name = normKey(product.name);
  if (name.length === 0) return false;
  return name === key || name.includes(key) || key.includes(name);
}

/** Shape one product into its live, per-line stock answer. */
export function describeLiveProduct(product: LiveProduct): LiveInventoryProduct {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const in_stock: LiveInventoryLine[] = [];
  const sold_out: Array<{ color: string | null; size: string | null }> = [];
  let total = 0;
  for (const v of variants) {
    const qty = Math.max(0, Math.floor(Number(v?.stock ?? 0) || 0));
    if (qty > 0) {
      total += qty;
      in_stock.push({
        color: v?.color ?? null,
        size: v?.size ?? null,
        quantity: qty,
        price: v?.price ?? product.price ?? null,
      });
    } else {
      sold_out.push({ color: v?.color ?? null, size: v?.size ?? null });
    }
  }
  return {
    product_id: String(product.id ?? ""),
    product_name: String(product.name ?? ""),
    total_quantity: total,
    status: total > 0 ? "in_stock" : "sold_out",
    in_stock,
    sold_out,
  };
}

export interface LiveInventoryResult {
  ok: true;
  read_at: string;
  matched: number;
  resolved: boolean;
  products: LiveInventoryProduct[];
  existing_order_addition_capacity?: string;
  rule: string;
}

export const LIVE_INVENTORY_RULE =
  "INTERNAL DATA — never shown to the customer, never quoted, never announced. These numbers were read from the store database at the moment of this call and REPLACE every earlier availability, colour, size, quantity or price you saw or said — including in this same turn. Speak only about lines listed under in_stock (quantity 1 or more). A line under sold_out does not exist for the customer unless he asked about it by name. If a product you mentioned before is not listed here, it no longer exists. Never blend these numbers with older ones and never apologise for a change. IMPORTANT FOR AN EXISTING ORDER: live quantity is stock remaining AFTER its paid pieces were deducted, so it is the number of EXTRA pieces available now, not the maximum total quantity of the updated order. If existing_order_addition_capacity is present, obey its arithmetic and never reject a requested new total that is within maximum_valid_new_total. A replenished piece shown in live stock can be added even when the earlier ordered piece had previously exhausted stock. This check is a silent verification: say NOTHING about it. Do not tell the customer 'it is available' again for something already established as available, and do not re-confirm availability at every step or at order confirmation — just continue the sale naturally. Speak about availability ONLY when a line is actually out of stock now, and then say it once, plainly, with a real in-stock alternative.";

export const LIVE_INVENTORY_UNRESOLVED_RULE =
  "The words you sent did not match any catalogue name, so this is the FULL live catalogue instead. This is NOT a sign that the product is unavailable — never tell the customer something does not exist because a lookup missed. The customer may be using a nickname, a misspelling, a pronoun ('اللي وريتهولي', 'التاني', 'نفسه') or referring to something discussed much earlier. Decide from the conversation itself which product he means, then answer from that product's lines below. If the conversation genuinely gives you no clue at all, ask him one short natural question to identify it — never declare it unavailable.";

/**
 * Build the tool answer from a FRESHLY re-read catalogue.
 *
 * A query that matches nothing NEVER means "unavailable": name matching is a
 * convenience, not the resolution mechanism. The customer may misspell, use a
 * nickname or a pronoun, or refer back to an old part of the conversation —
 * only the model, holding the whole conversation, can resolve that. So a miss
 * degrades to the full live catalogue plus an explicit instruction to resolve
 * the reference from context.
 */
export function buildLiveInventoryResult(
  products: LiveProduct[] | null | undefined,
  query: LiveInventoryQuery = {},
  options: { existingOrderAdditionCapacity?: string | null } = {},
): LiveInventoryResult {
  const list = (Array.isArray(products) ? products : []).filter(Boolean);
  const asked = Boolean(String(query.product_id ?? "").trim() || normKey(query.product_name));
  const matched = list.filter((p) => matchesQuery(p, query));
  const resolved = !asked || matched.length > 0;
  const out = resolved ? matched : list;
  const additionCapacity = String(options.existingOrderAdditionCapacity ?? "").trim();
  return {
    ok: true,
    read_at: new Date().toISOString(),
    matched: out.length,
    resolved,
    products: out.map(describeLiveProduct),
    ...(additionCapacity
      ? { existing_order_addition_capacity: additionCapacity }
      : {}),
    rule: resolved
      ? LIVE_INVENTORY_RULE
      : `${LIVE_INVENTORY_UNRESOLVED_RULE}\n${LIVE_INVENTORY_RULE}`,
  };
}

