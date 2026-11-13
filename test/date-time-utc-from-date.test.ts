import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import { dateTimeUtcFromDate } from "../src/lib/date-time-utc-from-date.ts"

describe("dateTimeUtcFromDate", () => {
  it("turns a Date into the same instant as DateTime.Utc", () => {
    expect(DateTime.formatIso(dateTimeUtcFromDate(new Date("2026-02-01T10:00:00Z")))).toBe("2026-02-01T10:00:00.000Z")
  })

  it("keeps null as null", () => expect(dateTimeUtcFromDate(null)).toBeNull())
})
