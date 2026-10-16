import { describe, expect, it } from "@effect/vitest"
import { matchTag } from "../src/lib/match-tag.ts"

type Shape =
  | { readonly _tag: "Circle"; readonly radius: number }
  | { readonly _tag: "Square"; readonly side: number }

const describeShape = matchTag<Shape>()({
  Circle: (circle) => ({ kind: "round", size: circle.radius }) as const,
  Square: (square) => square.side,
})

describe("matchTag", () => {
  it("calls the handler of the value's tag", () => {
    expect(describeShape({ _tag: "Circle", radius: 2 })).toEqual({ kind: "round", size: 2 })
    expect(describeShape({ _tag: "Square", side: 3 })).toBe(3)
  })

  it("types the result by the input's tag", () => {
    const square: { readonly _tag: "Square"; readonly side: number } = { _tag: "Square", side: 3 }
    const side: number = describeShape(square)
    // @ts-expect-error a Square never yields the Circle result
    const round: { readonly kind: "round" } = describeShape(square)
    expect([side, round]).toEqual([3, 3])
  })

  it("rejects a missing or unknown tag at compile time", () => {
    // @ts-expect-error Square has no handler
    matchTag<Shape>()({ Circle: () => 1 })
    // @ts-expect-error Triangle is not a tag of Shape
    matchTag<Shape>()({ Circle: () => 1, Square: () => 2, Triangle: () => 3 })
  })
})
