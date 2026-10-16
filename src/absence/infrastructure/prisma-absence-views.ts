import { Effect, Layer, Schema } from "effect"
import type { Prisma } from "~prisma/client"
import { PrismaService } from "~prisma/effect"
import { dateTimeUtcFromDate } from "../../lib/date-time-utc-from-date.ts"
import type { UserId } from "../../shared/ids.ts"
import { AbsenceVisibility } from "../domain/absence-actor.ts"
import { AbsenceNotFoundError } from "../domain/absence-error.ts"
import { AbsenceView, AbsenceViews } from "../view/absence-views.ts"

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
const hideOthersDraftsWhere = (userId: UserId): Prisma.AbsenceWhereInput =>
  ({ OR: [{ status: { not: "draft" } }, { creatorId: userId }] })

const absenceWhereFromVisibility = (visibility: AbsenceVisibility): Prisma.AbsenceWhereInput =>
  AbsenceVisibility.$match(visibility, {
    AllAbsences: () => ({}),
    OrganizationAbsences: ({ userId }) => hideOthersDraftsWhere(userId),
    InvolvedAbsences: ({ userId, relatedUserIds }) => ({
      AND: [
        hideOthersDraftsWhere(userId),
        { OR: [{ creatorId: userId }, { assigneeId: userId }, { assigneeId: { in: [...relatedUserIds] } }] },
      ],
    }),
  })

export const PrismaAbsenceViews = Layer.effect(AbsenceViews, Effect.gen(function* () {
  const prisma = yield* PrismaService

  return AbsenceViews.of({
    getAbsenceById: Effect.fn("PrismaAbsenceViews.getAbsenceById")(function* ({ organizationId, visibility, absenceId }) {
      const row = yield* prisma.absence.findFirst({
        where: { AND: [{ id: absenceId, organizationId }, absenceWhereFromVisibility(visibility)] },
        select: absenceViewSelect,
      }).pipe(Effect.orDie)
      if (row === null) return yield* new AbsenceNotFoundError({ absenceId })
      return yield* decodeAbsenceView(row)
    }),

    listAbsences: Effect.fn("PrismaAbsenceViews.listAbsences")(function* ({ organizationId, visibility, assigneeId, creatorId }) {
      const rows = yield* prisma.absence.findMany({
        where: {
          AND: [
            { organizationId },
            assigneeId === undefined ? {} : { assigneeId },   // an absent filter is no condition
            creatorId === undefined ? {} : { creatorId },
            absenceWhereFromVisibility(visibility),
          ],
        },
        select: absenceViewSelect,
        orderBy: { from: "asc" },
      }).pipe(Effect.orDie)
      return yield* Effect.forEach(rows, decodeAbsenceView)
    }),
  })
}))
