import { describe, expect, it } from "vitest";

import {
  ADDITION_CLAIM_CORRECTION,
  buildAdditionClaimJudgeMessages,
  parseAdditionClaimVerdict,
  shouldJudgeAdditionClaim,
} from "@/lib/order-addition-claim-guard";

const base = {
  hasExistingOrder: true,
  orderRegisteredThisTurn: false,
  correctionsIssued: 0,
  reply: "تمام، ضفتلك قطعة تانية، المطلوب 300 جنيه.",
};

describe("addition claim guard", () => {
  it("judges a reply only when an unregistered addition claim is possible", () => {
    expect(shouldJudgeAdditionClaim(base)).toBe(true);
    expect(shouldJudgeAdditionClaim({ ...base, hasExistingOrder: false })).toBe(false);
    expect(shouldJudgeAdditionClaim({ ...base, orderRegisteredThisTurn: true })).toBe(false);
    expect(shouldJudgeAdditionClaim({ ...base, correctionsIssued: 1 })).toBe(false);
    expect(shouldJudgeAdditionClaim({ ...base, reply: "  " })).toBe(false);
  });

  it("reads the verdict strictly", () => {
    expect(parseAdditionClaimVerdict("YES")).toBe(true);
    expect(parseAdditionClaimVerdict(" yes\n")).toBe(true);
    expect(parseAdditionClaimVerdict("NO")).toBe(false);
    expect(parseAdditionClaimVerdict("")).toBe(false);
    expect(parseAdditionClaimVerdict(null)).toBe(false);
    expect(parseAdditionClaimVerdict("maybe")).toBe(false);
  });

  it("passes both sides of the exchange to the judge", () => {
    const msgs = buildAdditionClaimJudgeMessages("ضفتها", "ضيف قطعة");
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toContain("ضيف قطعة");
    expect(msgs[1]!.content).toContain("ضفتها");
  });

  it("forces the registration path in the correction", () => {
    expect(ADDITION_CLAIM_CORRECTION).toContain("create_order");
    expect(ADDITION_CLAIM_CORRECTION).toContain("NEW TOTAL");
  });
});
