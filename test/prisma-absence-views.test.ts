import { describe, expect, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AbsenceVisibility, absenceVisibilityFromReader } from "../src/absence/domain/absence-actor.ts"
import { generateAbsenceId } from "../src/absence/domain/absence-id.ts"
import { PrismaAbsenceViews } from "../src/absence/infrastructure/prisma-absence-views.ts"
import { AbsenceViews } from "../src/absence/view/absence-views.ts"
import type { UserId } from "../src/shared/ids.ts"
import { alice, bob, child, makeActor, organizationId, otherOrganizationId, PrismaLayer, prismaClient, resetDatabase } from "./support.ts"

const TestLayer = PrismaAbsenceViews.pipe(Layer.provide(PrismaLayer))

// name → row; every reader below sees a subset of these names
const rows = {
  ownDraft: { creatorId: alice, assigneeId: alice, status: "draft" },
  othersDraft: { creatorId: bob, assigneeId: alice, status: "draft" },
  ownActive: { creatorId: alice, assigneeId: alice, status: "active" },
  assignedToMe: { creatorId: bob, assigneeId: alice, status: "active" },
  assignedToRelated: { creatorId: bob, assigneeId: child, status: "archived" },
  unrelated: { creatorId: bob, assigneeId: bob, status: "active" },
  otherOrganization: { creatorId: alice, assigneeId: alice, status: "active", organizationId: otherOrganizationId },
} as const satisfies Record<string, { creatorId: UserId; assigneeId: UserId; status: string; organizationId?: string }>

const seed = Effect.promise(async () => {
  await resetDatabase()
  const nameById = new Map<string, string>()
  for (const [name, row] of Object.entries(rows)) {
    const id = generateAbsenceId()
    nameById.set(id, name)
    await prismaClient.absence.create({
      data: {
        id, organizationId, ...row,
        from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-02T00:00:00Z"), createdAt: new Date("2026-02-01T10:00:00Z"),
        activatedAt: row.status === "draft" ? null : new Date("2026-02-01T10:05:00Z"),
        archivedAt: row.status === "archived" ? new Date("2026-03-03T00:00:00Z") : null,
      },
    })
  }
  return nameById
})

layer(TestLayer)("PrismaAbsenceViews", (it) => {
  describe("listAbsences returns only what the visibility allows", () => {
    const cases = [
      { reader: "InvolvedAbsences (alice)", visibility: absenceVisibilityFromReader(makeActor({ userId: alice, relatedUserIds: new Set([child]) })),
        expected: ["ownDraft", "ownActive", "assignedToMe", "assignedToRelated"] },
      { reader: "OrganizationAbsences (alice)", visibility: absenceVisibilityFromReader(makeActor({ userId: alice, mayReadOthersAbsences: true })),
        expected: ["ownDraft", "ownActive", "assignedToMe", "assignedToRelated", "unrelated"] },
      { reader: "AllAbsences (system)", visibility: AbsenceVisibility.AllAbsences(),
        expected: ["ownDraft", "othersDraft", "ownActive", "assignedToMe", "assignedToRelated", "unrelated"] },
    ]
    for (const { reader, visibility, expected } of cases) {
      it.effect(reader, () => Effect.gen(function* () {
        const nameById = yield* seed
        const absenceViews = yield* AbsenceViews
        const absences = yield* absenceViews.listAbsences({ organizationId, visibility })
        expect(absences.map((absence) => nameById.get(absence.absenceId)).sort()).toEqual([...expected].sort())
      }))
    }
  })

  it.effect("a filter on an unrelated user is [], not an error", () => Effect.gen(function* () {
    yield* seed
    const absenceViews = yield* AbsenceViews
    const visibility = absenceVisibilityFromReader(makeActor({ userId: alice }))
    expect(yield* absenceViews.listAbsences({ organizationId, visibility, assigneeId: bob })).toEqual([])
  }))

  it.effect("getAbsenceById of an invisible absence → AbsenceNotFoundError", () => Effect.gen(function* () {
    const nameById = yield* seed
    const absenceViews = yield* AbsenceViews
    const unrelatedId = [...nameById].find(([, name]) => name === "unrelated")![0]
    const error = yield* absenceViews.getAbsenceById({
      organizationId, visibility: absenceVisibilityFromReader(makeActor({ userId: alice })), absenceId: unrelatedId as never,
    }).pipe(Effect.flip)
    expect(error._tag).toBe("AbsenceNotFoundError")
  }))
})
