import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildLiveInventoryResult, describeLiveProduct } from "@/lib/live-inventory";

const products = [
  {
    id: "p1",
    name: "IKE BRAS هودي مخطط",
    price: 500,
    variants: [
      { color: "أحمر", size: "M", stock: 2 },
      { color: "أخضر", size: "M", stock: 0 },
    ],
  },
  { id: "p2", name: "تيشرت سادة", price: 200, variants: [{ color: "أبيض", size: "L", stock: 0 }] },
];

describe("live inventory tool", () => {
  it("splits live stock from sold-out lines", () => {
    const d = describeLiveProduct(products[0]!);
    expect(d.status).toBe("in_stock");
    expect(d.total_quantity).toBe(2);
    expect(d.in_stock).toHaveLength(1);
    expect(d.sold_out).toEqual([{ color: "أخضر", size: "M" }]);
  });

  it("marks a fully sold-out product", () => {
    expect(describeLiveProduct(products[1]!).status).toBe("sold_out");
  });

  it("matches the customer's loose wording to one product", () => {
    const r = buildLiveInventoryResult(products, { product_name: "هودي مخطط" });
    expect(r.matched).toBe(1);
    expect(r.products[0]!.product_id).toBe("p1");
  });

  it("returns the whole catalogue with no query", () => {
    expect(buildLiveInventoryResult(products).matched).toBe(2);
  });

  it("tells the agent that replenished live stock is extra capacity for an existing order", () => {
    const capacity = [
      "quantity_already_in_order: 1",
      "extra_pieces_available_now: 1",
      "maximum_valid_new_total: 2",
    ].join("\n");
    const result = buildLiveInventoryResult(
      products,
      { product_id: "p1" },
      { existingOrderAdditionCapacity: capacity },
    );

    expect(result.existing_order_addition_capacity).toBe(capacity);
    expect(result.rule).toContain("number of EXTRA pieces available now");
    expect(result.rule).toContain("replenished piece");
  });

  it("is exposed to the agent and re-reads the database on call", () => {
    const source = readFileSync("src/routes/api/chat-ai.ts", "utf8");
    expect(source).toContain("checkLiveInventoryTool");
    expect(source).toContain('fnName === "check_live_inventory"');
    expect(source).toContain("buildLiveInventoryResult");
    expect(source).toContain("existingOrderAdditionCapacity: existingOrderAdditionCapacityBlock");
    expect(source).toContain("CURRENT-MESSAGE INTENT GATE");
    expect(source).toContain("reply with one clarification question only");
  });
});

describe("unresolvable references never mean unavailable", () => {
  it("falls back to the whole live catalogue when the name matches nothing", () => {
    const res = buildLiveInventoryResult(
      [{ id: "p1", name: "هودي مخطط", variants: [{ color: "بيج", size: "L", stock: 2 }] }],
      { product_name: "اللي انت ورتهولي" },
    );
    expect(res.resolved).toBe(false);
    expect(res.products).toHaveLength(1);
    expect(res.rule).toContain("never tell the customer something does not exist");
  });

  it("marks a real match as resolved", () => {
    const res = buildLiveInventoryResult(
      [{ id: "p1", name: "هودي مخطط", variants: [{ color: "بيج", size: "L", stock: 2 }] }],
      { product_name: "هودي" },
    );
    expect(res.resolved).toBe(true);
    expect(res.rule).toContain("INTERNAL DATA");
  });
});

describe("tolerant product wording", () => {
  it("does not force a short unclear word (هادي) onto هودي", () => {
    const r = buildLiveInventoryResult(products, { product_name: "هادي" });
    expect(r.resolved).toBe(false);
    expect(r.matched).toBe(2);
    expect(r.rule).toContain("ask him one short natural question");
  });

  it("never forces a typo (تيشيرت) onto a catalogue product — it stays unresolved", () => {
    const r = buildLiveInventoryResult(products, { product_name: "تيشيرت" });
    expect(r.resolved).toBe(false);
    expect(r.matched).toBe(2);
    expect(r.rule).toContain("ask him one short natural question");
  });

  it("still degrades to the full catalogue for a totally unknown word", () => {
    const r = buildLiveInventoryResult(products, { product_name: "بنطلون جينز" });
    expect(r.resolved).toBe(false);
    expect(r.matched).toBe(2);
  });
});
