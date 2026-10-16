import { describe, expect, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { AbsenceArchivedEvent, AbsenceDeletedEvent, AbsenceDraftedEvent } from "../src/absence/domain/absence-event.ts"
import { generateAbsenceId, type AbsenceId } from "../src/absence/domain/absence-id.ts"
import { AbsenceRepository, type FindAbsenceByIdInput } from "../src/absence/domain/absence-repository.ts"
import { PrismaAbsenceRepository } from "../src/absence/infrastructure/prisma-absence-repository.ts"
import { alice, at, host, HostLayer, organizationId, otherOrganizationId, PrismaLayer, prismaClient, resetDatabase, resetHost } from "./support.ts"

const TestLayer = PrismaAbsenceRepository.pipe(Layer.provide([PrismaLayer, HostLayer]))

const insertAbsenceRow = (status: "draft" | "active" | "archived", overrides: { activatedAt?: Date | null } = {}) =>
  Effect.promise(async () => {
    const id = generateAbsenceId()
    await prismaClient.absence.create({
      data: {
        id, organizationId, creatorId: alice, assigneeId: alice, status,
        from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-02T00:00:00Z"), createdAt: new Date("2026-02-01T10:00:00Z"),
        activatedAt: status === "draft" ? null : new Date("2026-02-01T10:05:00Z"),
        archivedAt: status === "archived" ? new Date("2026-03-03T00:00:00Z") : null,
        ...overrides,
      },
    })
    return id
  })

const reset = Effect.promise(async () => { await resetDatabase(); resetHost() })
const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(Effect.map((exit) =>
    Exit.isSuccess(exit) ? "ok" : Cause.hasDies(exit.cause) ? "die" : Cause.findErrorOption(exit.cause).pipe((option) => option._tag === "Some" ? option.value._tag : "?")))

layer(TestLayer)("PrismaAbsenceRepository", (it) => {
  describe("finds let through only their states", () => {
    const table = [
      ["findDraftAbsenceById", { draft: "ok", active: "AbsenceAlreadyActiveError", archived: "AbsenceAlreadyArchivedError" }],
      ["findActiveAbsenceById", { draft: "AbsenceStillDraftError", active: "ok", archived: "AbsenceAlreadyArchivedError" }],
      ["findEditableAbsenceById", { draft: "ok", active: "ok", archived: "AbsenceAlreadyArchivedError" }],
    ] as const
    for (const [find, expectedByStatus] of table) {
      for (const [status, expected] of Object.entries(expectedByStatus)) {
        it.effect(`${find}: ${status} → ${expected}`, () => Effect.gen(function* () {
          yield* reset
          const absenceId = yield* insertAbsenceRow(status as "draft" | "active" | "archived")
          const absenceRepository = yield* AbsenceRepository
          const findAbsence: (input: FindAbsenceByIdInput) => Effect.Effect<unknown, { readonly _tag: string }> = absenceRepository[find]
          expect(yield* outcome(findAbsence({ organizationId, absenceId }))).toBe(expected)
        }))
      }
    }

    it.effect("another organization's absence → AbsenceNotFoundError", () => Effect.gen(function* () {
      yield* reset
      const absenceId = yield* insertAbsenceRow("draft")
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.findDraftAbsenceById({ organizationId: otherOrganizationId, absenceId })))
        .toBe("AbsenceNotFoundError")
    }))

    it.effect("an active row without activatedAt is corrupt → die", () => Effect.gen(function* () {
      yield* reset
      const absenceId = yield* insertAbsenceRow("active", { activatedAt: null })
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.findActiveAbsenceById({ organizationId, absenceId }))).toBe("die")
    }))
  })

  describe("publishAbsenceEvent: guarded writes", () => {
    const now = at("2026-03-05T00:00:00Z")
    const archivedEvent = (absenceId: AbsenceId) =>
      AbsenceArchivedEvent.make({ absenceId, organizationId, actorId: alice, occurredOn: now })

    it.effect("archive an active row: written, then published", () => Effect.gen(function* () {
      yield* reset
      const absenceId = yield* insertAbsenceRow("active")
      const absenceRepository = yield* AbsenceRepository
      yield* absenceRepository.publishAbsenceEvent(archivedEvent(absenceId))
      const row = yield* Effect.promise(() => prismaClient.absence.findUniqueOrThrow({ where: { id: absenceId } }))
      expect(row.status).toBe("archived")
      expect(row.archivedAt?.toISOString()).toBe("2026-03-05T00:00:00.000Z")
      expect(host.publishedEvents).toHaveLength(1)
    }))

    it.effect("archive a row that is no longer active → AbsenceChangedConcurrentlyError, nothing published", () => Effect.gen(function* () {
      yield* reset
      const absenceId = yield* insertAbsenceRow("draft")
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.publishAbsenceEvent(archivedEvent(absenceId)))).toBe("AbsenceChangedConcurrentlyError")
      expect(host.publishedEvents).toHaveLength(0)
    }))

    it.effect("delete an archived row → AbsenceChangedConcurrentlyError, row kept", () => Effect.gen(function* () {
      yield* reset
      const absenceId = yield* insertAbsenceRow("archived")
      const absenceRepository = yield* AbsenceRepository
      const event = AbsenceDeletedEvent.make({
        absenceId, organizationId, actorId: alice, occurredOn: now, assigneeId: alice,
        period: { from: at("2026-03-01T00:00:00Z"), to: at("2026-03-02T00:00:00Z") },
      })
      expect(yield* outcome(absenceRepository.publishAbsenceEvent(event))).toBe("AbsenceChangedConcurrentlyError")
      expect(yield* Effect.promise(() => prismaClient.absence.count({ where: { id: absenceId } }))).toBe(1)
    }))

    it.effect("drafted with a taken id → AbsenceAlreadyExistsError", () => Effect.gen(function* () {
      yield* reset
      const absenceRepository = yield* AbsenceRepository
      const event = AbsenceDraftedEvent.make({
        absenceId: generateAbsenceId(), organizationId, actorId: alice, occurredOn: now, creatorId: alice, assigneeId: alice,
        period: { from: at("2026-03-01T00:00:00Z"), to: at("2026-03-02T00:00:00Z") },
      })
      expect(yield* outcome(absenceRepository.publishAbsenceEvent(event))).toBe("ok")
      expect(yield* outcome(absenceRepository.publishAbsenceEvent(event))).toBe("AbsenceAlreadyExistsError")
      const draft = yield* absenceRepository.findDraftAbsenceById({ organizationId, absenceId: event.absenceId })
      expect(draft).toMatchObject({ _tag: "DraftAbsence", creatorId: alice, createdAt: now })
    }))
  })
})
