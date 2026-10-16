import { Context, Effect } from "effect"
import type { OfTag } from "../../lib/match-tag.ts"
import type { OrganizationId } from "../../shared/ids.ts"
import type {
  AbsenceAlreadyActiveError, AbsenceAlreadyArchivedError, AbsenceAlreadyExistsError,
  AbsenceChangedConcurrentlyError, AbsenceNotFoundError, AbsenceStillDraftError,
} from "./absence-error.ts"
import type { AbsenceEvent } from "./absence-event.ts"
import type { AbsenceId } from "./absence-id.ts"
import type { ActiveAbsence, DraftAbsence, EditableAbsence } from "./absence.ts"

export type FindAbsenceByIdInput = { readonly organizationId: OrganizationId; readonly absenceId: AbsenceId }

// The constraint makes it exhaustive: a new event doesn't compile until it names its write error.
type ByAbsenceEventTag<T extends Record<AbsenceEvent["_tag"], unknown>> = T
export type AbsenceEventWriteErrors = ByAbsenceEventTag<{
  AbsenceDraftedEvent: AbsenceAlreadyExistsError
  AbsenceRescheduledEvent: AbsenceChangedConcurrentlyError
  AbsenceReassignedEvent: AbsenceChangedConcurrentlyError
  AbsenceActivatedEvent: AbsenceChangedConcurrentlyError
  AbsenceArchivedEvent: AbsenceChangedConcurrentlyError
  AbsenceDeletedEvent: AbsenceChangedConcurrentlyError
}>

export class AbsenceRepository extends Context.Service<AbsenceRepository, {
  findDraftAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<DraftAbsence, AbsenceNotFoundError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError>
  findActiveAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<ActiveAbsence, AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError>
  findEditableAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<EditableAbsence, AbsenceNotFoundError | AbsenceAlreadyArchivedError>
  publishAbsenceEvent<Tag extends AbsenceEvent["_tag"]>(event: OfTag<AbsenceEvent, Tag>): Effect.Effect<void, AbsenceEventWriteErrors[Tag]>
}>()("AbsenceRepository") {}
