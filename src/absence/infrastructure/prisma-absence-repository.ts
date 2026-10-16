import { DateTime, Effect, Layer, Match, Predicate, Schema } from "effect"
import type { Prisma } from "~prisma/client"
import { PrismaService, type PrismaDeleteError, type PrismaUpdateError } from "~prisma/effect"
import { dateTimeUtcFromDate } from "../../lib/date-time-utc-from-date.ts"
import { matchTag, type OfTag } from "../../lib/match-tag.ts"
import { withOptionalTag } from "../../lib/with-optional-tag.ts"
import { DomainEvents } from "../../shared/domain-events.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { ActiveAbsence, DraftAbsence } from "../domain/absence.ts"
import {
  AbsenceAlreadyActiveError, AbsenceAlreadyArchivedError, AbsenceAlreadyExistsError,
  AbsenceChangedConcurrentlyError, AbsenceNotFoundError, AbsenceStillDraftError,
} from "../domain/absence-error.ts"
import type {
  AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDeletedEvent, AbsenceDraftedEvent, AbsenceEvent,
  AbsenceReassignedEvent, AbsenceRescheduledEvent,
} from "../domain/absence-event.ts"
import {
  AbsenceRepository, type AbsenceEventWriteErrors, type FindAbsenceByIdInput,
} from "../domain/absence-repository.ts"

// No archivedAt: no find returns an archived absence.
const absenceSelect = {
  id: true, organizationId: true, creatorId: true, assigneeId: true,
  from: true, to: true, status: true, createdAt: true, activatedAt: true,
} satisfies Prisma.AbsenceSelect

type AbsenceRow = Prisma.AbsenceGetPayload<{ select: typeof absenceSelect }>

const DraftAbsenceFromFields = withOptionalTag(DraftAbsence)
const ActiveAbsenceFromFields = withOptionalTag(ActiveAbsence).mapFields((fields) => ({
  ...fields,
  // the column is nullable, the state isn't: a null fails the decode
  activatedAt: Schema.NullOr(Schema.DateTimeUtc).pipe(Schema.refine(Predicate.isNotNull)),
}))

const absenceFieldsFromRow = (row: AbsenceRow) => ({
  absenceId: row.id,
  organizationId: row.organizationId,
  creatorId: row.creatorId,
  assigneeId: row.assigneeId,
  period: { from: dateTimeUtcFromDate(row.from), to: dateTimeUtcFromDate(row.to) },
  createdAt: dateTimeUtcFromDate(row.createdAt),
})

// A row that doesn't decode is corrupt: die.
const decodeDraftAbsence = (row: AbsenceRow) =>
  Schema.decodeEffect(DraftAbsenceFromFields)(absenceFieldsFromRow(row)).pipe(Effect.orDie)

const decodeActiveAbsence = (row: AbsenceRow) =>
  Schema.decodeEffect(ActiveAbsenceFromFields)({
    ...absenceFieldsFromRow(row),
    activatedAt: dateTimeUtcFromDate(row.activatedAt),
  }).pipe(Effect.orDie)

export const PrismaAbsenceRepository = Layer.effect(AbsenceRepository, Effect.gen(function* () {
  const prisma = yield* PrismaService
  const domainEvents = yield* DomainEvents

  const findAbsenceRow = ({ organizationId, absenceId }: FindAbsenceByIdInput) =>
    prisma.absence.findUnique({ where: { id: absenceId, organizationId }, select: absenceSelect }).pipe(
      Effect.orDie,
      Effect.flatMap((row) => row === null ? Effect.fail(new AbsenceNotFoundError({ absenceId })) : Effect.succeed(row)),
    )

  // An unknown status makes Match.exhaustive throw: a defect.
  const findDraftAbsenceById = Effect.fn("PrismaAbsenceRepository.findDraftAbsenceById")(
    function* ({ organizationId, absenceId }: FindAbsenceByIdInput) {
      const row = yield* findAbsenceRow({ organizationId, absenceId })
      return yield* Match.value(row.status).pipe(
        Match.when("draft", () => decodeDraftAbsence(row)),
        Match.when("active", () => Effect.fail(new AbsenceAlreadyActiveError({ absenceId }))),
        Match.when("archived", () => Effect.fail(new AbsenceAlreadyArchivedError({ absenceId }))),
        Match.exhaustive,
      )
    },
  )

  const findActiveAbsenceById = Effect.fn("PrismaAbsenceRepository.findActiveAbsenceById")(
    function* ({ organizationId, absenceId }: FindAbsenceByIdInput) {
      const row = yield* findAbsenceRow({ organizationId, absenceId })
      return yield* Match.value(row.status).pipe(
        Match.when("draft", () => Effect.fail(new AbsenceStillDraftError({ absenceId }))),
        Match.when("active", () => decodeActiveAbsence(row)),
        Match.when("archived", () => Effect.fail(new AbsenceAlreadyArchivedError({ absenceId }))),
        Match.exhaustive,
      )
    },
  )

  const findEditableAbsenceById = Effect.fn("PrismaAbsenceRepository.findEditableAbsenceById")(
    function* ({ organizationId, absenceId }: FindAbsenceByIdInput) {
      const row = yield* findAbsenceRow({ organizationId, absenceId })
      return yield* Match.value(row.status).pipe(
        Match.when("draft", () => decodeDraftAbsence(row)),
        Match.when("active", () => decodeActiveAbsence(row)),
        Match.when("archived", () => Effect.fail(new AbsenceAlreadyArchivedError({ absenceId }))),
        Match.exhaustive,
      )
    },
  )

  // The guard matched no row: the absence changed or vanished since the find. Any other Prisma error dies.
  const failOnNoMatchingRow = (absenceId: AbsenceId) =>
    <A>(write: Effect.Effect<A, PrismaUpdateError | PrismaDeleteError>) =>
      write.pipe(Effect.catchTag(
        "PrismaRecordNotFoundError",
        () => Effect.fail(new AbsenceChangedConcurrentlyError({ absenceId })),
        (error) => Effect.die(error),
      ))

  const writeAbsenceDraftedEvent = (event: AbsenceDraftedEvent) =>
    prisma.absence.create({
      data: {
        id: event.absenceId,
        organizationId: event.organizationId,
        creatorId: event.creatorId,
        assigneeId: event.assigneeId,
        from: DateTime.toDateUtc(event.period.from),
        to: DateTime.toDateUtc(event.period.to),
        status: "draft",
        createdAt: DateTime.toDateUtc(event.occurredOn),
      },
      select: { id: true },
    }).pipe(
      // the primary key is the only unique constraint
      Effect.catchTag(
        "PrismaUniqueConstraintError",
        () => Effect.fail(new AbsenceAlreadyExistsError({ absenceId: event.absenceId })),
        (error) => Effect.die(error),
      ),
      Effect.asVoid,
    )

  const writeAbsenceRescheduledEvent = (event: AbsenceRescheduledEvent) =>
    prisma.absence.update({
      where: { id: event.absenceId, organizationId: event.organizationId, status: { in: ["draft", "active"] } },
      data: { from: DateTime.toDateUtc(event.period.from), to: DateTime.toDateUtc(event.period.to) },
      select: { id: true },
    }).pipe(failOnNoMatchingRow(event.absenceId), Effect.asVoid)

  const writeAbsenceReassignedEvent = (event: AbsenceReassignedEvent) =>
    prisma.absence.update({
      where: { id: event.absenceId, organizationId: event.organizationId, status: { in: ["draft", "active"] } },
      data: { assigneeId: event.assigneeId },
      select: { id: true },
    }).pipe(failOnNoMatchingRow(event.absenceId), Effect.asVoid)

  const writeAbsenceActivatedEvent = (event: AbsenceActivatedEvent) =>
    prisma.absence.update({
      where: { id: event.absenceId, organizationId: event.organizationId, status: "draft" },
      data: { status: "active", activatedAt: DateTime.toDateUtc(event.occurredOn) },
      select: { id: true },
    }).pipe(failOnNoMatchingRow(event.absenceId), Effect.asVoid)

  const writeAbsenceArchivedEvent = (event: AbsenceArchivedEvent) =>
    prisma.absence.update({
      where: { id: event.absenceId, organizationId: event.organizationId, status: "active" },
      data: { status: "archived", archivedAt: DateTime.toDateUtc(event.occurredOn) },
      select: { id: true },
    }).pipe(failOnNoMatchingRow(event.absenceId), Effect.asVoid)

  const writeAbsenceDeletedEvent = (event: AbsenceDeletedEvent) =>
    prisma.absence.delete({
      where: { id: event.absenceId, organizationId: event.organizationId, status: { in: ["draft", "active"] } },
      select: { id: true },
    }).pipe(failOnNoMatchingRow(event.absenceId), Effect.asVoid)

  // Out is the port's error map, given explicitly: inferred from the writes, it wouldn't match AbsenceEventWriteErrors[Tag] for a generic Tag.
  const writeAbsenceEvent = matchTag<AbsenceEvent>()<{
    readonly [Tag in AbsenceEvent["_tag"]]: Effect.Effect<void, AbsenceEventWriteErrors[Tag]>
  }>({
    AbsenceDraftedEvent: writeAbsenceDraftedEvent,
    AbsenceRescheduledEvent: writeAbsenceRescheduledEvent,
    AbsenceReassignedEvent: writeAbsenceReassignedEvent,
    AbsenceActivatedEvent: writeAbsenceActivatedEvent,
    AbsenceArchivedEvent: writeAbsenceArchivedEvent,
    AbsenceDeletedEvent: writeAbsenceDeletedEvent,
  })

  const publishAbsenceEvent = Effect.fn("PrismaAbsenceRepository.publishAbsenceEvent")(
    function* <Tag extends AbsenceEvent["_tag"]>(event: OfTag<AbsenceEvent, Tag>) {
      yield* writeAbsenceEvent(event)
      yield* domainEvents.publishDomainEvent(event)   // not atomic with the write
    },
  )

  return AbsenceRepository.of({
    findDraftAbsenceById,
    findActiveAbsenceById,
    findEditableAbsenceById,
    publishAbsenceEvent,
  })
}))
