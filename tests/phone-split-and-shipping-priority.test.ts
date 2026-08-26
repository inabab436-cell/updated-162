import { describe, it, expect } from "vitest";
import { readTurnPhone, buildPhoneStateBlock } from "@/lib/phone-confirmation";
import { resolveShippingCoverage } from "@/lib/shipping-lookup.server";
describe("case", () => {
  it("joins split number in one message", () => {
    const t = readTurnPhone([], "منه البرادي 012 الغربيه 42428684");
    expect(t).toEqual({ phone: "01242428684", valid: true, assembled: true });
    expect(buildPhoneStateBlock({ phone: t!.phone, assembled: true })).toContain("01242428684");
  });
  it("does not glue quantities", () => {
    expect(readTurnPhone([], "عايز 3 قطع مقاس 42")).toBeNull();
  });
  it("coverage", () => {
    const z = [{ country: "مصر", region: "الشرقية", price: 60, currency: "ج.م", eta: "2" }] as any;
    expect(resolveShippingCoverage(z, ["انا من الغربيه"]).status).toBe("uncovered");
    expect(resolveShippingCoverage(z, ["انا من الشرقيه"]).status).toBe("covered");
  });
});
