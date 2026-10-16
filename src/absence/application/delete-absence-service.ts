import { Context, DateTime, Effect, Layer } from "effect"
import type { OrganizationId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError, NotAllowedToDeleteAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"
import { deleteAbsence } from "../domain/absence.ts"

export type DeleteAbsenceCommand = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class DeleteAbsenceService extends Context.Service<DeleteAbsenceService, {
  deleteAbsence(command: DeleteAbsenceCommand): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyArchivedError
    | NotAllowedToDeleteAbsenceError
    | AbsenceChangedConcurrentlyError>
}>()("DeleteAbsenceService") {
  static layer = Layer.effect(DeleteAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    return DeleteAbsenceService.of({
      deleteAbsence: Effect.fn("DeleteAbsenceService.deleteAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findEditableAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(deleteAbsence({ absence, actor, now }))
        yield* absenceRepository.publishAbsenceEvent(event)
      }),
    })
  }))
}
