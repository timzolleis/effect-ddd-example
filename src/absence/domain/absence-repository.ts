import type { DateTime } from "effect"
import { Context, Effect } from "effect"
import type { OrganizationId } from "../../shared/ids.ts"
import type {
  AbsenceAlreadyActiveError, AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError,
  AbsenceStillDraftError,
} from "./absence-error.ts"
import type { AbsenceId } from "./absence-id.ts"
import type { Absence, ActiveAbsence, DraftAbsence, EditableAbsence } from "./absence.ts"

export type FindAbsenceByIdInput = { readonly organizationId: OrganizationId; readonly absenceId: AbsenceId }

// One write per kind of event, with the states it needs: a create has no state before.
export type InsertAbsenceInput = { readonly after: Absence }
export type UpdateAbsenceInput = { readonly before: Absence; readonly after: Absence }

export type PurgeArchivedAbsencesInput = { readonly archivedBefore: DateTime.Utc }

export class AbsenceRepository extends Context.Service<AbsenceRepository, {
  findDraftAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<DraftAbsence, AbsenceNotFoundError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError>
  findActiveAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<ActiveAbsence, AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError>
  findEditableAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<EditableAbsence, AbsenceNotFoundError | AbsenceAlreadyArchivedError>
  insertAbsence(input: InsertAbsenceInput): Effect.Effect<void, AbsenceChangedConcurrentlyError>
  updateAbsence(input: UpdateAbsenceInput): Effect.Effect<void, AbsenceChangedConcurrentlyError>
  // archived and discarded rows, every organization: the retention sweep
  purgeArchivedAbsences(input: PurgeArchivedAbsencesInput): Effect.Effect<void>
}>()("AbsenceRepository") {}
