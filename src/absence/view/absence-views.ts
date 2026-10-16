import { Context, Effect, Schema } from "effect"
import { UserId, type OrganizationId } from "../../shared/ids.ts"
import type { AbsenceVisibility } from "../domain/absence-actor.ts"
import type { AbsenceNotFoundError } from "../domain/absence-error.ts"
import { AbsenceId } from "../domain/absence-id.ts"

// Also the API response schema. No organizationId: every request is scoped to one.
export const AbsenceView = Schema.Struct({
  absenceId: AbsenceId,
  creatorId: UserId,
  assigneeId: UserId,
  from: Schema.DateTimeUtc,
  to: Schema.DateTimeUtc,
  status: Schema.Literals(["draft", "active", "archived"]),
  createdAt: Schema.DateTimeUtc,
  activatedAt: Schema.NullOr(Schema.DateTimeUtc),
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
})
export type AbsenceView = typeof AbsenceView.Type

export class AbsenceViews extends Context.Service<AbsenceViews, {
  // not visible = not found
  getAbsenceById(input: {
    readonly organizationId: OrganizationId; readonly visibility: AbsenceVisibility; readonly absenceId: AbsenceId
  }): Effect.Effect<AbsenceView, AbsenceNotFoundError>
  // filters combine with AND, then visibility; an absent filter is no condition
  listAbsences(input: {
    readonly organizationId: OrganizationId; readonly visibility: AbsenceVisibility
    readonly assigneeId?: UserId | undefined; readonly creatorId?: UserId | undefined
  }): Effect.Effect<ReadonlyArray<AbsenceView>>
}>()("AbsenceViews") {}
