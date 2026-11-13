import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { withOptionalTag } from "../src/lib/with-optional-tag.ts"

const Circle = Schema.TaggedStruct("Circle", { radius: Schema.Number })
const CircleFromFields = withOptionalTag(Circle)

describe("withOptionalTag", () => {
  it("decodes input without _tag into the tagged value", () =>
    expect(Schema.decodeUnknownSync(CircleFromFields)({ radius: 2 })).toEqual({ _tag: "Circle", radius: 2 }))

  it("still decodes input with its own _tag", () =>
    expect(Schema.decodeUnknownSync(CircleFromFields)({ _tag: "Circle", radius: 2 })).toEqual({ _tag: "Circle", radius: 2 }))

  it("rejects another _tag", () =>
    expect(() => Schema.decodeUnknownSync(CircleFromFields)({ _tag: "Square", radius: 2 })).toThrow())
})
