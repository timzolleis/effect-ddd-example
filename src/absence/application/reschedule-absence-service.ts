import { Context, DateTime, Effect, Layer } from "effect"
import type { OrganizationId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceEditWindowClosedError, AbsenceNotFoundError,
  InvalidPeriodError, NotAllowedToEditAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"
import { rescheduleAbsence } from "../domain/absence.ts"

export type RescheduleAbsenceCommand = {
  readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId
  readonly from: DateTime.Utc; readonly to: DateTime.Utc
}

export class RescheduleAbsenceService extends Context.Service<RescheduleAbsenceService, {
  rescheduleAbsence(command: RescheduleAbsenceCommand): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyArchivedError
    | NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError | InvalidPeriodError
    | AbsenceChangedConcurrentlyError>
}>()("RescheduleAbsenceService") {
  static layer = Layer.effect(RescheduleAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    return RescheduleAbsenceService.of({
      rescheduleAbsence: Effect.fn("RescheduleAbsenceService.rescheduleAbsence")(function* ({ organizationId, actor, absenceId, from, to }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findEditableAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(rescheduleAbsence({ absence, actor, from, to, now }))
        yield* absenceRepository.publishAbsenceEvent(event)
      }),
    })
  }))
}
