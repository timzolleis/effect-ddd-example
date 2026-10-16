import { Effect, Layer, Schema } from "effect"
import type { Prisma } from "~prisma/client"
import { PrismaService } from "~prisma/effect"
import { dateTimeUtcFromDate } from "../../lib/date-time-utc-from-date.ts"
import type { UserId } from "../../shared/ids.ts"
import { AbsenceVisibility } from "../domain/absence-actor.ts"
import { AbsenceNotFoundError } from "../domain/absence-error.ts"
import { AbsenceView, AbsenceViews, type AbsenceListFilters } from "../view/absence-views.ts"

const absenceViewSelect = {
  id: true, creatorId: true, assigneeId: true, from: true, to: true, status: true,
  createdAt: true, activatedAt: true, archivedAt: true,
} satisfies Prisma.AbsenceSelect

type AbsenceViewRow = Prisma.AbsenceGetPayload<{ select: typeof absenceViewSelect }>

const decodeAbsenceView = (row: AbsenceViewRow) =>
  Schema.decodeEffect(AbsenceView)({
    absenceId: row.id,
    creatorId: row.creatorId,
    assigneeId: row.assigneeId,
    from: dateTimeUtcFromDate(row.from),
    to: dateTimeUtcFromDate(row.to),
    status: row.status,
    createdAt: dateTimeUtcFromDate(row.createdAt),
    activatedAt: dateTimeUtcFromDate(row.activatedAt),
    archivedAt: dateTimeUtcFromDate(row.archivedAt),
  }).pipe(Effect.orDie)

// Only translates the visibility; absenceVisibilityFromReader and system callers choose it.
const nonDraftOrCreatedByWhere = (userId: UserId): Prisma.AbsenceWhereInput =>
  ({ OR: [{ status: { not: "draft" } }, { creatorId: userId }] })

const absenceWhereFromFilters = ({ assigneeId, creatorId }: AbsenceListFilters): Prisma.AbsenceWhereInput => ({
  AND: [
    assigneeId === undefined ? {} : { assigneeId },
    creatorId === undefined ? {} : { creatorId },
  ],
})

const absenceWhereFromVisibility = (visibility: AbsenceVisibility): Prisma.AbsenceWhereInput =>
  AbsenceVisibility.$match(visibility, {
    AllAbsences: () => ({}),
    OrganizationAbsences: ({ userId }) => nonDraftOrCreatedByWhere(userId),
    InvolvedAbsences: ({ userId, relatedUserIds }) => ({
      AND: [
        nonDraftOrCreatedByWhere(userId),
        { OR: [{ creatorId: userId }, { assigneeId: userId }, { assigneeId: { in: [...relatedUserIds] } }] },
      ],
    }),
  })

export const PrismaAbsenceViews = Layer.effect(AbsenceViews, Effect.gen(function* () {
  const prisma = yield* PrismaService

  return AbsenceViews.of({
    getAbsenceById: Effect.fn("PrismaAbsenceViews.getAbsenceById")(function* ({ organizationId, visibility, absenceId }) {
      // Not visible = no row = AbsenceNotFoundError; any other Prisma error dies.
      const row = yield* prisma.absence.findUniqueOrThrow({
        where: { id: absenceId, organizationId, AND: [absenceWhereFromVisibility(visibility)] },
        select: absenceViewSelect,
      }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceNotFoundError({ absenceId }),
          (error) => Effect.die(error),
        ),
      )
      return yield* decodeAbsenceView(row)
    }),

    listAbsences: Effect.fn("PrismaAbsenceViews.listAbsences")(function* ({ organizationId, visibility, filters }) {
      const rows = yield* prisma.absence.findMany({
        where: { organizationId, AND: [absenceWhereFromFilters(filters), absenceWhereFromVisibility(visibility)] },
        select: absenceViewSelect,
        orderBy: { from: "asc" },
      }).pipe(Effect.orDie)
      return yield* Effect.forEach(rows, decodeAbsenceView)
    }),
  })
}))
