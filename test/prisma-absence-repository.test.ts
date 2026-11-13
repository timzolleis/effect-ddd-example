import { describe, expect, layer } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Layer, Match } from "effect"
import { AbsenceStatus } from "~prisma/client"
import { AbsenceRepository, type FindAbsenceByIdInput } from "../src/absence/domain/absence-repository.ts"
import { Absence, AbsenceArchivedEvent, type ActiveAbsence } from "../src/absence/domain/absence.ts"
import { PrismaAbsenceRepository } from "../src/absence/infrastructure/prisma-absence-repository.ts"
import {
  alice, at, HostLayer, makeActiveAbsence, makeArchivedAbsence, makeDiscardedAbsence, makeDraftAbsence, organizationId, otherOrganizationId,
  PrismaLayer,
  prismaClient, resetDatabase, resetHost,
} from "./support.ts"

const TestLayer = PrismaAbsenceRepository.pipe(Layer.provide([PrismaLayer, HostLayer]))

const statusColumns = (absence: Absence) => Match.valueTags(absence, {
  DraftAbsence: () => ({ status: AbsenceStatus.draft, activatedAt: null, archivedAt: null }),
  ActiveAbsence: (absence) => ({ status: AbsenceStatus.active, activatedAt: DateTime.toDateUtc(absence.activatedAt), archivedAt: null }),
  ArchivedAbsence: (absence) => ({
    status: AbsenceStatus.archived, activatedAt: DateTime.toDateUtc(absence.activatedAt), archivedAt: DateTime.toDateUtc(absence.archivedAt),
  }),
  DiscardedAbsence: (absence) => ({ status: AbsenceStatus.discarded, activatedAt: null, archivedAt: DateTime.toDateUtc(absence.archivedAt) }),
})

// A state's row, written directly with Prisma; overrides make a row no write produces.
const insertAbsenceRow = <A extends Absence>(absence: A, overrides: { readonly activatedAt?: Date | null } = {}) =>
  Effect.promise(() => prismaClient.absence.create({
    data: {
      id: absence.absenceId, organizationId: absence.organizationId, creatorId: absence.creatorId, assigneeId: absence.assigneeId,
      from: DateTime.toDateUtc(absence.period.from), to: DateTime.toDateUtc(absence.period.to),
      createdAt: DateTime.toDateUtc(absence.createdAt), updatedAt: DateTime.toDateUtc(absence.updatedAt),
      ...statusColumns(absence),
      ...overrides,
    },
  })).pipe(Effect.as(absence))

const absenceInState = { draft: makeDraftAbsence, active: makeActiveAbsence, archived: makeArchivedAbsence, discarded: makeDiscardedAbsence }

const reset = Effect.promise(async () => { await resetDatabase(); resetHost() })
const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(Effect.map((exit) =>
    Exit.isSuccess(exit) ? "ok" : Cause.hasDies(exit.cause) ? "die" : Cause.findErrorOption(exit.cause).pipe((option) => option._tag === "Some" ? option.value._tag : "?")))

layer(TestLayer)("PrismaAbsenceRepository", (it) => {
  describe("finds let through only their states", () => {
    const table = [
      ["findDraftAbsenceById", { draft: "ok", active: "AbsenceAlreadyActiveError", archived: "AbsenceAlreadyArchivedError", discarded: "AbsenceAlreadyArchivedError" }],
      ["findActiveAbsenceById", { draft: "AbsenceStillDraftError", active: "ok", archived: "AbsenceAlreadyArchivedError", discarded: "AbsenceAlreadyArchivedError" }],
      ["findEditableAbsenceById", { draft: "ok", active: "ok", archived: "AbsenceAlreadyArchivedError", discarded: "AbsenceAlreadyArchivedError" }],
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
    const archivedEvent = (absence: ActiveAbsence) =>
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
      expect(yield* outcome(absenceRepository.updateAbsence({ before, after: Absence.evolve({ absence: before, event }) }))).toBe("AbsenceChangedConcurrentlyError")
      const row = yield* Effect.promise(() => prismaClient.absence.findUniqueOrThrow({ where: { id: absence.absenceId } }))
      expect(row.status).toBe("active")
    }))

  })

  describe("purgeArchivedAbsences", () => {
    it.effect("deletes archived and discarded rows archived before the cutoff, and nothing else", () => Effect.gen(function* () {
      yield* reset
      // fixtures archive at 2026-03-03 and discard at 2026-02-01T10:30
      const archived = yield* insertAbsenceRow(makeArchivedAbsence())
      yield* insertAbsenceRow(makeDiscardedAbsence())
      const draft = yield* insertAbsenceRow(makeDraftAbsence())
      const active = yield* insertAbsenceRow(makeActiveAbsence())
      const absenceRepository = yield* AbsenceRepository
      const remainingIds = Effect.promise(() => prismaClient.absence.findMany({ select: { id: true }, orderBy: { id: "asc" } }))
        .pipe(Effect.map((rows) => rows.map((row) => row.id)))
      yield* absenceRepository.purgeArchivedAbsences({ archivedBefore: at("2026-03-01T00:00:00Z") })
      expect(yield* remainingIds).toEqual([archived, draft, active].map((absence) => absence.absenceId).sort())
      yield* absenceRepository.purgeArchivedAbsences({ archivedBefore: at("2026-03-03T00:00:00Z") })   // lt: the cutoff instant stays
      expect(yield* remainingIds).toEqual([archived, draft, active].map((absence) => absence.absenceId).sort())
      yield* absenceRepository.purgeArchivedAbsences({ archivedBefore: at("2026-03-04T00:00:00Z") })
      expect(yield* remainingIds).toEqual([draft, active].map((absence) => absence.absenceId).sort())
    }))
  })
})
