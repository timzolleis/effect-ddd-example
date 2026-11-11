import { describe, expect, layer } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Layer, Match } from "effect"
import { AbsenceStatus } from "~prisma/client"
import { AbsenceArchivedEvent } from "../src/absence/domain/absence-event.ts"
import { AbsenceRepository, type FindAbsenceByIdInput } from "../src/absence/domain/absence-repository.ts"
import { evolveAbsence, type Absence } from "../src/absence/domain/absence.ts"
import { PrismaAbsenceRepository } from "../src/absence/infrastructure/prisma-absence-repository.ts"
import {
  alice, at, HostLayer, makeActiveAbsence, makeArchivedAbsence, makeDraftAbsence, organizationId, otherOrganizationId, PrismaLayer,
  prismaClient, resetDatabase, resetHost,
} from "./support.ts"

const TestLayer = PrismaAbsenceRepository.pipe(Layer.provide([PrismaLayer, HostLayer]))

// A state's row, written directly with Prisma; overrides make a row no write produces.
const insertAbsenceRow = (absence: Absence, overrides: { readonly activatedAt?: Date | null } = {}) =>
  Effect.promise(() => prismaClient.absence.create({
    data: {
      id: absence.absenceId, organizationId: absence.organizationId, creatorId: absence.creatorId, assigneeId: absence.assigneeId,
      from: DateTime.toDateUtc(absence.period.from), to: DateTime.toDateUtc(absence.period.to),
      createdAt: DateTime.toDateUtc(absence.createdAt), updatedAt: DateTime.toDateUtc(absence.updatedAt),
      ...Match.valueTags(absence, {
        DraftAbsence: () => ({ status: AbsenceStatus.draft, activatedAt: null, archivedAt: null }),
        ActiveAbsence: (absence) => ({ status: AbsenceStatus.active, activatedAt: DateTime.toDateUtc(absence.activatedAt), archivedAt: null }),
        ArchivedAbsence: (absence) => ({
          status: AbsenceStatus.archived, activatedAt: DateTime.toDateUtc(absence.activatedAt), archivedAt: DateTime.toDateUtc(absence.archivedAt),
        }),
      }),
      ...overrides,
    },
  })).pipe(Effect.as(absence))

const absenceInState = { draft: makeDraftAbsence, active: makeActiveAbsence, archived: makeArchivedAbsence }

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
          const { absenceId } = yield* insertAbsenceRow(absenceInState[status as keyof typeof absenceInState]())
          const absenceRepository = yield* AbsenceRepository
          const findAbsence: (input: FindAbsenceByIdInput) => Effect.Effect<unknown, { readonly _tag: string }> = absenceRepository[find]
          expect(yield* outcome(findAbsence({ organizationId, absenceId }))).toBe(expected)
        }))
      }
    }

    it.effect("another organization's absence → AbsenceNotFoundError", () => Effect.gen(function* () {
      yield* reset
      const { absenceId } = yield* insertAbsenceRow(makeDraftAbsence())
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.findDraftAbsenceById({ organizationId: otherOrganizationId, absenceId })))
        .toBe("AbsenceNotFoundError")
    }))

    it.effect("an active row without activatedAt is corrupt → die", () => Effect.gen(function* () {
      yield* reset
      const { absenceId } = yield* insertAbsenceRow(makeActiveAbsence(), { activatedAt: null })
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.findActiveAbsenceById({ organizationId, absenceId }))).toBe("die")
    }))
  })

  describe("writes fail when another write came first", () => {
    const archivedEvent = (absence: Absence) =>
      AbsenceArchivedEvent.make({ absenceId: absence.absenceId, organizationId, actorId: alice, occurredOn: at("2026-03-05T00:00:00Z") })

    it.effect("insert with a taken id → AbsenceChangedConcurrentlyError", () => Effect.gen(function* () {
      yield* reset
      const absence = yield* insertAbsenceRow(makeDraftAbsence())
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.insertAbsence({ after: absence }))).toBe("AbsenceChangedConcurrentlyError")
    }))

    it.effect("fails with ChangedConcurrently when the row changed after the find", () => Effect.gen(function* () {
      yield* reset
      const absence = yield* insertAbsenceRow(makeActiveAbsence({ activatedOn: at("2026-02-01T10:05:00Z") }))
      const before = { ...absence, updatedAt: at("2026-02-01T10:00:00Z") }
      const event = archivedEvent(absence)
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.updateAbsence({ before, after: evolveAbsence({ absence: before, event }) }))).toBe("AbsenceChangedConcurrentlyError")
      const row = yield* Effect.promise(() => prismaClient.absence.findUniqueOrThrow({ where: { id: absence.absenceId } }))
      expect(row.status).toBe("active")
    }))

    it.effect("delete a row that changed after the find → AbsenceChangedConcurrentlyError, row kept", () => Effect.gen(function* () {
      yield* reset
      const absence = yield* insertAbsenceRow(makeActiveAbsence())
      const before = { ...absence, updatedAt: at("2026-02-01T10:00:00Z") }
      const absenceRepository = yield* AbsenceRepository
      expect(yield* outcome(absenceRepository.deleteAbsence({ before }))).toBe("AbsenceChangedConcurrentlyError")
      expect(yield* Effect.promise(() => prismaClient.absence.count({ where: { id: absence.absenceId } }))).toBe(1)
    }))
  })
})
