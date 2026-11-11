import { describe, expect, it, layer } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ArchiveAbsenceService } from "../src/absence/application/archive-absence-service.ts"
import { AbsenceChangedConcurrentlyError } from "../src/absence/domain/absence-error.ts"
import { AbsenceArchivedEvent } from "../src/absence/domain/absence-event.ts"
import { AbsenceRepository } from "../src/absence/domain/absence-repository.ts"
import { PrismaAbsenceRepository } from "../src/absence/infrastructure/prisma-absence-repository.ts"
import { PrismaTransactions } from "../src/lib/prisma-transactions.ts"
import { DomainEvent, DomainEventOutbox } from "../src/shared/domain-events.ts"
import {
  alice, at, listOutboxEventTags, makeActiveAbsence, makeActor, organizationId, PrismaHostLayer, PrismaLayer, prismaClient,
  resetDatabase,
} from "./support.ts"

const afterTheAbsence = TestClock.setTime(DateTime.toEpochMillis(at("2026-03-04T00:00:00Z")))
const archiveAnActiveAbsence = Effect.gen(function* () {
  yield* Effect.promise(() => resetDatabase())
  yield* afterTheAbsence
  const absence = makeActiveAbsence()
  yield* (yield* AbsenceRepository).insertAbsence({ after: absence })
  const exit = yield* (yield* ArchiveAbsenceService).archiveAbsence({ organizationId, actor: makeActor({ userId: alice }), absenceId: absence.absenceId })
    .pipe(Effect.exit)
  const row = yield* Effect.promise(() => prismaClient.absence.findUniqueOrThrow({ where: { id: absence.absenceId } }))
  return { absence, exit, status: row.status }
})

describe("ArchiveAbsenceService: the archive and its event commit together", () => {
  layer(ArchiveAbsenceService.layer.pipe(Layer.provideMerge(PrismaAbsenceRepository), Layer.provide(PrismaHostLayer)))((it) => {
    it.effect("archived row and outbox row", () => Effect.gen(function* () {
      const { absence, exit, status } = yield* archiveAnActiveAbsence
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(status).toBe("archived")
      const [outboxRow] = yield* Effect.promise(() => prismaClient.outboxEvent.findMany())
      const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(DomainEvent)))(outboxRow?.payload)
      expect(event).toEqual(AbsenceArchivedEvent.make({
        absenceId: absence.absenceId, organizationId, actorId: alice, occurredOn: at("2026-03-04T00:00:00Z"),
      }))
    }))
  })

  const FailingOutbox = Layer.succeed(DomainEventOutbox, DomainEventOutbox.of({ addDomainEvent: () => Effect.die("outbox down") }))
  layer(ArchiveAbsenceService.layer.pipe(
    Layer.provideMerge(PrismaAbsenceRepository),
    Layer.provide([PrismaTransactions, FailingOutbox]),
    Layer.provideMerge(PrismaLayer),
  ))((it) => {
    it.effect("a failed outbox write rolls the archive back and stays a defect", () => Effect.gen(function* () {
      const { exit, status } = yield* archiveAnActiveAbsence
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true)
      expect(status).toBe("active")
      expect(yield* listOutboxEventTags()).toEqual([])
    }))
  })

  const absence = makeActiveAbsence()
  const StaleRepository = Layer.mock(AbsenceRepository, {
    findActiveAbsenceById: () => Effect.succeed(absence),
    updateAbsence: () => Effect.fail(new AbsenceChangedConcurrentlyError({ absenceId: absence.absenceId })),
  })
  layer(ArchiveAbsenceService.layer.pipe(Layer.provide([StaleRepository, PrismaHostLayer]), Layer.provideMerge(PrismaLayer)))((it) => {
    it.effect("a domain error inside the transaction stays typed", () => Effect.gen(function* () {
      yield* Effect.promise(() => resetDatabase())
      yield* afterTheAbsence
      const error = yield* (yield* ArchiveAbsenceService)
        .archiveAbsence({ organizationId, actor: makeActor({ userId: alice }), absenceId: absence.absenceId }).pipe(Effect.flip)
      expect(error._tag).toBe("AbsenceChangedConcurrentlyError")
      expect(yield* listOutboxEventTags()).toEqual([])
    }))
  })

  it("an outbox write outside a transaction doesn't compile", () => {
    const outsideATransaction = (outbox: DomainEventOutbox["Service"], event: DomainEvent) => {
      // @ts-expect-error Transaction is missing: only runInTransaction provides it
      const effect: Effect.Effect<void> = outbox.addDomainEvent(event)
      return effect
    }
    expect(outsideATransaction).toBeTypeOf("function")
  })
})
