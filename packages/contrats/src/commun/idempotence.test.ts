import { describe, expect, it } from "vitest";
import { cleDIntention } from "./idempotence.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("idempotence", () => {
  it("[C-535] la même intention donne la même Idempotency-Key", () => {
    const a = cleDIntention("devis.creer", "proposition-0001");
    expect(cleDIntention("devis.creer", "proposition-0001")).toBe(a);
    expect(a).toMatch(UUID_V4);
  });

  it("[C-535] deux intentions différentes donnent deux clés", () => {
    expect(cleDIntention("devis.creer", "proposition-0001")).not.toBe(cleDIntention("devis.creer", "proposition-0002"));
    expect(cleDIntention("devis.creer", "x")).not.toBe(cleDIntention("plan.creer", "x"));
    expect(cleDIntention("a", "b\nc")).not.toBe(cleDIntention("a\nb", "c"));
  });
});
