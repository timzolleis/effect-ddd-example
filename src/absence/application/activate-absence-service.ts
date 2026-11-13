import { Context, DateTime, Effect, Layer } from "effect"
import { DomainEvents } from "../../shared/domain-events.ts"
import type { OrganizationId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import { Absence, ActivateAbsenceCommand } from "../domain/absence.ts"
import type {
  AbsenceAlreadyActiveError, AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError,
  NotAbsenceCreatorError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"

export type ActivateAbsenceRequest = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class ActivateAbsenceService extends Context.Service<ActivateAbsenceService, {
  activateAbsence(request: ActivateAbsenceRequest): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError
    | NotAbsenceCreatorError
    | AbsenceChangedConcurrentlyError>
}>()("ActivateAbsenceService") {
  static layer = Layer.effect(ActivateAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const domainEvents = yield* DomainEvents
    return ActivateAbsenceService.of({
      activateAbsence: Effect.fn("ActivateAbsenceService.activateAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findDraftAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(Absence.decide({ absence, command: ActivateAbsenceCommand.make({ actor }), now }))
        yield* absenceRepository.updateAbsence({ before: absence, after: Absence.evolve({ absence, event }) })
        yield* domainEvents.publishDomainEvent(event)
      }),
    })
  }))
}
