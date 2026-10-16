import { Context, DateTime, Effect, Layer } from "effect"
import type { OrganizationId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import type {
  AbsenceAlreadyActiveError, AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError,
  NotAbsenceCreatorError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"
import { activateAbsence } from "../domain/absence.ts"

export type ActivateAbsenceCommand = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class ActivateAbsenceService extends Context.Service<ActivateAbsenceService, {
  activateAbsence(command: ActivateAbsenceCommand): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError
    | NotAbsenceCreatorError
    | AbsenceChangedConcurrentlyError>
}>()("ActivateAbsenceService") {
  static layer = Layer.effect(ActivateAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    return ActivateAbsenceService.of({
      activateAbsence: Effect.fn("ActivateAbsenceService.activateAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findDraftAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(activateAbsence({ absence, actor, now }))
        yield* absenceRepository.publishAbsenceEvent(event)
      }),
    })
  }))
}
