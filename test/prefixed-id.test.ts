import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { createPrefixedId, prefixedId } from "../src/lib/prefixed-id.ts"

describe("prefixedId", () => {
  const isAbsenceIdShaped = Schema.is(prefixedId("abs"))

  it("accepts an id createPrefixedId generated with the same prefix", () =>
    expect(isAbsenceIdShaped(createPrefixedId("abs"))).toBe(true))

  it.each([
    { id: createPrefixedId("usr"), case: "another prefix" },
    { id: "abs_123", case: "a short body" },
    { id: `abs_${"A".repeat(24)}`, case: "uppercase" },
    { id: `abs_1${"a".repeat(23)}`, case: "a body starting with a digit" },
  ])("rejects $case", ({ id }) => expect(isAbsenceIdShaped(id)).toBe(false))
})
