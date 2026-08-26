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

/** Levenshtein distance, capped for short strings. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/** A near-miss word (typo, dialect, missing long vowel) still counts as a hit. */
function fuzzyHit(nameWord: string, keyWord: string): boolean {
  if (!nameWord || !keyWord) return false;
  if (nameWord === keyWord) return true;
  if (nameWord.includes(keyWord) || keyWord.includes(nameWord)) return true;
  // A short unknown word is too ambiguous to force onto a catalogue item.
  // Return no match so the agent asks what the customer means instead.
  if (Math.min(nameWord.length, keyWord.length) < 5) return false;
  return distance(nameWord, keyWord) <= 2;
}

function words(value: unknown): string[] {
  return String(value ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => normKey(w))
    .filter((w) => w.length > 1);
}

function matchesQuery(product: LiveProduct, query: LiveInventoryQuery): boolean {
  const id = String(query.product_id ?? "").trim();
  if (id) return String(product.id ?? "") === id;
  const key = normKey(query.product_name);
  if (!key) return true;
  const name = normKey(product.name);
  if (name.length === 0) return false;
  if (name === key || name.includes(key) || key.includes(name)) return true;
  // Word-level tolerant comparison: the customer writes "هادي" for "هودي",
  // "تيشيرت" for "تيشرت", or only one word of a longer catalogue name.
  const nameWords = words(product.name);
  const keyWords = words(query.product_name);
  if (nameWords.length === 0 || keyWords.length === 0) return false;
  return keyWords.some((kw) => nameWords.some((nw) => fuzzyHit(nw, kw)));
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

