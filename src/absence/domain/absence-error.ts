import { Data, DateTime } from "effect"
import type { UserId } from "../../shared/ids.ts"
import type { AbsenceId } from "./absence-id.ts"
import type { EditableAbsence } from "./absence.ts"
import type { Period } from "./period.ts"

// raised by the finds (and AbsenceViews.getAbsenceById)
export class AbsenceNotFoundError extends Data.TaggedError("AbsenceNotFoundError")<{ readonly absenceId: AbsenceId }> {}
export class AbsenceStillDraftError extends Data.TaggedError("AbsenceStillDraftError")<{ readonly absenceId: AbsenceId }> {}
export class AbsenceAlreadyActiveError extends Data.TaggedError("AbsenceAlreadyActiveError")<{ readonly absenceId: AbsenceId }> {}
export class AbsenceAlreadyArchivedError extends Data.TaggedError("AbsenceAlreadyArchivedError")<{ readonly absenceId: AbsenceId }> {}

// raised by the policies and createPeriod
export class NotAbsenceCreatorError extends Data.TaggedError("NotAbsenceCreatorError")<{
  readonly absenceId: AbsenceId; readonly actorId: UserId
}> {}
export class NotAllowedToEditAbsenceError extends Data.TaggedError("NotAllowedToEditAbsenceError")<{
  readonly absenceId: AbsenceId; readonly actorId: UserId; readonly absenceState: EditableAbsence["_tag"]
}> {}
export class NotAllowedToDeleteAbsenceError extends Data.TaggedError("NotAllowedToDeleteAbsenceError")<{
  readonly absenceId: AbsenceId; readonly actorId: UserId; readonly absenceState: EditableAbsence["_tag"]
}> {}

export class AssigneeNotInOrganizationError extends Data.TaggedError("AssigneeNotInOrganizationError")<{
  readonly assigneeId: UserId
}> {}
export class NotAllowedToAssignAbsenceError extends Data.TaggedError("NotAllowedToAssignAbsenceError")<{
  readonly actorId: UserId; readonly assigneeId: UserId
}> {}
export class AbsenceEditWindowClosedError extends Data.TaggedError("AbsenceEditWindowClosedError")<{
  readonly absenceId: AbsenceId; readonly createdAt: DateTime.Utc; readonly editableUntil: DateTime.Utc
}> {}
export class AbsenceOngoingError extends Data.TaggedError("AbsenceOngoingError")<{
  readonly absenceId: AbsenceId; readonly period: Period
}> {}
export class InvalidPeriodError extends Data.TaggedError("InvalidPeriodError")<{
  readonly from: DateTime.Utc; readonly to: DateTime.Utc
}> {}

// raised by publishAbsenceEvent
export class AbsenceChangedConcurrentlyError extends Data.TaggedError("AbsenceChangedConcurrentlyError")<{ readonly absenceId: AbsenceId }> {}
export class AbsenceAlreadyExistsError extends Data.TaggedError("AbsenceAlreadyExistsError")<{ readonly absenceId: AbsenceId }> {}

// Only for the exhaustive HTTP mapper; never in a signature.
export type AbsenceError =
  | AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError
  | NotAbsenceCreatorError | NotAllowedToEditAbsenceError | NotAllowedToDeleteAbsenceError
  | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError
  | AbsenceOngoingError | InvalidPeriodError | AbsenceChangedConcurrentlyError | AbsenceAlreadyExistsError
