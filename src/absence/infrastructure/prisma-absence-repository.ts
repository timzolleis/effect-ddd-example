import { DateTime, Effect, Layer, Match, Predicate, Schema } from "effect"
import { AbsenceStatus, type Prisma } from "~prisma/client"
import { PrismaService } from "~prisma/effect"
import { dateTimeUtcFromDate } from "../../lib/date-time-utc-from-date.ts"
import { withOptionalTag } from "../../lib/with-optional-tag.ts"
import { ActiveAbsence, DraftAbsence, type Absence } from "../domain/absence.ts"
import {
  AbsenceAlreadyActiveError, AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError,
  AbsenceStillDraftError,
} from "../domain/absence-error.ts"
import {
  AbsenceRepository, type FindAbsenceByIdInput, type InsertAbsenceInput, type PurgeArchivedAbsencesInput, type UpdateAbsenceInput,
} from "../domain/absence-repository.ts"

// No archivedAt: no find returns an archived or discarded absence.
const absenceSelect = {
  id: true, organizationId: true, creatorId: true, assigneeId: true,
  from: true, to: true, status: true, createdAt: true, updatedAt: true, activatedAt: true,
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
  updatedAt: dateTimeUtcFromDate(row.updatedAt),
})

// A row that doesn't decode is corrupt: die.
const decodeDraftAbsence = (row: AbsenceRow) =>
  Schema.decodeEffect(DraftAbsenceFromFields)(absenceFieldsFromRow(row)).pipe(Effect.orDie)

const decodeActiveAbsence = (row: AbsenceRow) =>
  Schema.decodeEffect(ActiveAbsenceFromFields)({
    ...absenceFieldsFromRow(row),
    activatedAt: dateTimeUtcFromDate(row.activatedAt),
  }).pipe(Effect.orDie)

const absenceColumnsFromFields = (absence: Absence) => ({
  id: absence.absenceId,
  organizationId: absence.organizationId,
  creatorId: absence.creatorId,
  assigneeId: absence.assigneeId,
  from: DateTime.toDateUtc(absence.period.from),
  to: DateTime.toDateUtc(absence.period.to),
  createdAt: DateTime.toDateUtc(absence.createdAt),
  updatedAt: DateTime.toDateUtc(absence.updatedAt),
})

const absenceRowFromState = (absence: Absence): Prisma.AbsenceUncheckedCreateInput =>
  Match.valueTags(absence, {
    DraftAbsence: (absence) => ({ ...absenceColumnsFromFields(absence), status: AbsenceStatus.draft, activatedAt: null, archivedAt: null }),
    ActiveAbsence: (absence) => ({ ...absenceColumnsFromFields(absence), status: AbsenceStatus.active, activatedAt: DateTime.toDateUtc(absence.activatedAt), archivedAt: null }),
    ArchivedAbsence: (absence) => ({ ...absenceColumnsFromFields(absence), status: AbsenceStatus.archived, activatedAt: DateTime.toDateUtc(absence.activatedAt), archivedAt: DateTime.toDateUtc(absence.archivedAt) }),
    DiscardedAbsence: (absence) => ({ ...absenceColumnsFromFields(absence), status: AbsenceStatus.discarded, activatedAt: null, archivedAt: DateTime.toDateUtc(absence.archivedAt) }),
  })

// the row the write must still find: before's identity and updatedAt
const absenceGuard = (before: Absence) =>
  ({ id: before.absenceId, organizationId: before.organizationId, updatedAt: DateTime.toDateUtc(before.updatedAt) })

export const PrismaAbsenceRepository = Layer.effect(AbsenceRepository, Effect.gen(function* () {
  const prisma = yield* PrismaService

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
        Match.when("discarded", () => new AbsenceAlreadyArchivedError({ absenceId })),
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
        Match.when("discarded", () => new AbsenceAlreadyArchivedError({ absenceId })),
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
        Match.when("discarded", () => new AbsenceAlreadyArchivedError({ absenceId })),
        Match.exhaustive,
      )
    },
  )

  const insertAbsence = Effect.fn("PrismaAbsenceRepository.insertAbsence")(
    function* ({ after }: InsertAbsenceInput) {
      yield* prisma.absence.create({ data: absenceRowFromState(after), select: { id: true } }).pipe(
        Effect.catchTag(
          "PrismaUniqueConstraintError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: after.absenceId }),
          (error) => Effect.die(error),
        ),
      )
    },
  )

  const updateAbsence = Effect.fn("PrismaAbsenceRepository.updateAbsence")(
    function* ({ before, after }: UpdateAbsenceInput) {
      yield* prisma.absence.update({ where: absenceGuard(before), data: absenceRowFromState(after), select: { id: true } }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: before.absenceId }),
          (error) => Effect.die(error),
        ),
      )
    },
  )

  const purgeArchivedAbsences = Effect.fn("PrismaAbsenceRepository.purgeArchivedAbsences")(
    function* ({ archivedBefore }: PurgeArchivedAbsencesInput) {
      yield* prisma.absence.deleteMany({
        where: { status: { in: [AbsenceStatus.archived, AbsenceStatus.discarded] }, archivedAt: { lt: DateTime.toDateUtc(archivedBefore) } },
      }).pipe(Effect.orDie)
    },
  )

  return AbsenceRepository.of({
    findDraftAbsenceById,
    findActiveAbsenceById,
    findEditableAbsenceById,
    insertAbsence,
    updateAbsence,
    purgeArchivedAbsences,
  })
}))
