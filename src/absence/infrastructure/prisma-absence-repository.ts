import { DateTime, Effect, Layer, Match, Predicate, Schema } from "effect"
import type { Prisma } from "~prisma/client"
import { PrismaService } from "~prisma/effect"
import { dateTimeUtcFromDate } from "../../lib/date-time-utc-from-date.ts"
import { matchTag, type MemberWithTag } from "../../lib/match-tag.ts"
import { withOptionalTag } from "../../lib/with-optional-tag.ts"
import { DomainEvents } from "../../shared/domain-events.ts"
import { ActiveAbsence, DraftAbsence } from "../domain/absence.ts"
import {
  AbsenceAlreadyActiveError, AbsenceAlreadyArchivedError, AbsenceAlreadyExistsError,
  AbsenceChangedConcurrentlyError, AbsenceNotFoundError, AbsenceStillDraftError,
} from "../domain/absence-error.ts"
import type { AbsenceEvent } from "../domain/absence-event.ts"
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

  // No row in the organization is the expected failure; any other Prisma error dies. An unknown status makes Match.exhaustive throw: a defect.
  const findDraftAbsenceById = Effect.fn("PrismaAbsenceRepository.findDraftAbsenceById")(
    function* ({ organizationId, absenceId }: FindAbsenceByIdInput) {
      const row = yield* prisma.absence.findUniqueOrThrow({ where: { id: absenceId, organizationId }, select: absenceSelect }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceNotFoundError({ absenceId }),
          (error) => Effect.die(error),
        ),
      )
      return yield* Match.value(row.status).pipe(
        Match.when("draft", () => decodeDraftAbsence(row)),
        Match.when("active", () => new AbsenceAlreadyActiveError({ absenceId })),
        Match.when("archived", () => new AbsenceAlreadyArchivedError({ absenceId })),
        Match.exhaustive,
      )
    },
  )

  const findActiveAbsenceById = Effect.fn("PrismaAbsenceRepository.findActiveAbsenceById")(
    function* ({ organizationId, absenceId }: FindAbsenceByIdInput) {
      const row = yield* prisma.absence.findUniqueOrThrow({ where: { id: absenceId, organizationId }, select: absenceSelect }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceNotFoundError({ absenceId }),
          (error) => Effect.die(error),
        ),
      )
      return yield* Match.value(row.status).pipe(
        Match.when("draft", () => new AbsenceStillDraftError({ absenceId })),
        Match.when("active", () => decodeActiveAbsence(row)),
        Match.when("archived", () => new AbsenceAlreadyArchivedError({ absenceId })),
        Match.exhaustive,
      )
    },
  )

  const findEditableAbsenceById = Effect.fn("PrismaAbsenceRepository.findEditableAbsenceById")(
    function* ({ organizationId, absenceId }: FindAbsenceByIdInput) {
      const row = yield* prisma.absence.findUniqueOrThrow({ where: { id: absenceId, organizationId }, select: absenceSelect }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceNotFoundError({ absenceId }),
          (error) => Effect.die(error),
        ),
      )
      return yield* Match.value(row.status).pipe(
        Match.when("draft", () => decodeDraftAbsence(row)),
        Match.when("active", () => decodeActiveAbsence(row)),
        Match.when("archived", () => new AbsenceAlreadyArchivedError({ absenceId })),
        Match.exhaustive,
      )
    },
  )

  // Out is the port's error map, given explicitly: inferred from the writes, it wouldn't match AbsenceEventWriteErrors[Tag] for a generic Tag.
  // A guarded write that matches no row means the absence changed or vanished since the find. Any other Prisma error dies.
  const writeAbsenceEvent = matchTag<AbsenceEvent>()<{
    readonly [Tag in AbsenceEvent["_tag"]]: Effect.Effect<void, AbsenceEventWriteErrors[Tag]>
  }>({
    AbsenceDraftedEvent: (event) =>
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
        Effect.catchTag(
          "PrismaUniqueConstraintError",
          () => new AbsenceAlreadyExistsError({ absenceId: event.absenceId }),
          (error) => Effect.die(error),
        ),
        Effect.asVoid,
      ),
    AbsenceRescheduledEvent: (event) =>
      prisma.absence.update({
        where: { id: event.absenceId, organizationId: event.organizationId, status: { in: ["draft", "active"] } },
        data: { from: DateTime.toDateUtc(event.period.from), to: DateTime.toDateUtc(event.period.to) },
        select: { id: true },
      }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: event.absenceId }),
          (error) => Effect.die(error),
        ),
        Effect.asVoid,
      ),
    AbsenceReassignedEvent: (event) =>
      prisma.absence.update({
        where: { id: event.absenceId, organizationId: event.organizationId, status: { in: ["draft", "active"] } },
        data: { assigneeId: event.assigneeId },
        select: { id: true },
      }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: event.absenceId }),
          (error) => Effect.die(error),
        ),
        Effect.asVoid,
      ),
    AbsenceActivatedEvent: (event) =>
      prisma.absence.update({
        where: { id: event.absenceId, organizationId: event.organizationId, status: "draft" },
        data: { status: "active", activatedAt: DateTime.toDateUtc(event.occurredOn) },
        select: { id: true },
      }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: event.absenceId }),
          (error) => Effect.die(error),
        ),
        Effect.asVoid,
      ),
    AbsenceArchivedEvent: (event) =>
      prisma.absence.update({
        where: { id: event.absenceId, organizationId: event.organizationId, status: "active" },
        data: { status: "archived", archivedAt: DateTime.toDateUtc(event.occurredOn) },
        select: { id: true },
      }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: event.absenceId }),
          (error) => Effect.die(error),
        ),
        Effect.asVoid,
      ),
    AbsenceDeletedEvent: (event) =>
      prisma.absence.delete({
        where: { id: event.absenceId, organizationId: event.organizationId, status: { in: ["draft", "active"] } },
        select: { id: true },
      }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: event.absenceId }),
          (error) => Effect.die(error),
        ),
        Effect.asVoid,
      ),
  })

  const publishAbsenceEvent = Effect.fn("PrismaAbsenceRepository.publishAbsenceEvent")(
    function* <Tag extends AbsenceEvent["_tag"]>(event: MemberWithTag<AbsenceEvent, Tag>) {
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
