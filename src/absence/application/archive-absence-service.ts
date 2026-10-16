import { Context, DateTime, Effect, Layer } from "effect"
import type { OrganizationId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError, AbsenceOngoingError,
  AbsenceStillDraftError, NotAllowedToEditAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"
import { archiveAbsence } from "../domain/absence.ts"

export type ArchiveAbsenceCommand = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class ArchiveAbsenceService extends Context.Service<ArchiveAbsenceService, {
  archiveAbsence(command: ArchiveAbsenceCommand): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError
    | NotAllowedToEditAbsenceError | AbsenceOngoingError
    | AbsenceChangedConcurrentlyError>
}>()("ArchiveAbsenceService") {
  static layer = Layer.effect(ArchiveAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    return ArchiveAbsenceService.of({
      archiveAbsence: Effect.fn("ArchiveAbsenceService.archiveAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findActiveAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(archiveAbsence({ absence, actor, now }))
        yield* absenceRepository.publishAbsenceEvent(event)
      }),
    })
  }))
}
