import { describe, it, expect } from "vitest";
import {
  checkIdentityIntake,
  buildIdentityIntakeBlock,
} from "@/lib/identity-intake";

describe("immediate identity intake validation", () => {
  it("flags a single-word name", () => {
    const issues = checkIdentityIntake({ name: "أحمد" });
    expect(issues.map((i) => i.field)).toEqual(["name"]);
  });

  it("accepts a two-part name", () => {
    expect(checkIdentityIntake({ name: "أحمد محمود" })).toEqual([]);
  });

  it("flags a phone that is not 11 digits", () => {
    expect(checkIdentityIntake({ phone: "0100123456" })[0]?.field).toBe("phone");
    expect(checkIdentityIntake({ phone: "01001234567" })).toEqual([]);
  });

  it("keeps phone problems as internal instructions, never as canned customer sentences", () => {
    const issue = checkIdentityIntake({ phone: "012884" })[0];
    expect(issue).toMatchObject({ field: "phone", reason: "too_short", value: "012884" });
    // The ask is an internal instruction to the agent, not a ready-made reply.
    expect(issue?.ask).toMatch(/ناقص|مش كامل/);
    expect(issue?.ask).not.toContain("11 رقم");
    expect(issue?.ask).not.toContain("015");
  });

  it("flags an address that is only a governorate", () => {
    const issues = checkIdentityIntake({ address: "القاهرة" });
    expect(issues[0]?.field).toBe("address");
    expect(issues[0]?.missing).toContain("street_or_landmark");
  });

  it("accepts a detailed address", () => {
    expect(
      checkIdentityIntake({ address: "القاهرة - مدينة نصر - شارع عباس العقاد برج ٥" }),
    ).toEqual([]);
  });

  it("ignores fields the customer has not given yet", () => {
    expect(checkIdentityIntake({})).toEqual([]);
  });

  it("builds an empty prompt block when everything is valid", () => {
    expect(buildIdentityIntakeBlock([])).toBe("");
  });

  it("builds a prompt block that demands correction in the same turn", () => {
    const block = buildIdentityIntakeBlock(checkIdentityIntake({ name: "أحمد" }));
    expect(block).toContain("تحقّق فوري");
    expect(block.length).toBeGreaterThan(20);
  });
});
