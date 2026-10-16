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

// Absent filter = no condition. Named for the reader, not for a column: the adapter maps each one.
export type AbsenceListFilters = { readonly assigneeId?: UserId; readonly creatorId?: UserId }

export class AbsenceViews extends Context.Service<AbsenceViews, {
  // not visible = not found
  getAbsenceById(input: {
    readonly organizationId: OrganizationId; readonly visibility: AbsenceVisibility; readonly absenceId: AbsenceId
  }): Effect.Effect<AbsenceView, AbsenceNotFoundError>
  // filters combine with AND, then visibility
  listAbsences(input: {
    readonly organizationId: OrganizationId; readonly visibility: AbsenceVisibility; readonly filters: AbsenceListFilters
  }): Effect.Effect<ReadonlyArray<AbsenceView>>
}>()("AbsenceViews") {}
