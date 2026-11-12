import { Context, DateTime, Effect, Layer } from "effect"
import { DomainEvents } from "../../shared/domain-events.ts"
import type { OrganizationId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import { Absence, ArchiveAbsenceCommand } from "../domain/absence-aggregate.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError, AbsenceOngoingError,
  AbsenceStillDraftError, NotAllowedToEditAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"

export type ArchiveAbsenceRequest = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class ArchiveAbsenceService extends Context.Service<ArchiveAbsenceService, {
  archiveAbsence(request: ArchiveAbsenceRequest): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError
    | NotAllowedToEditAbsenceError | AbsenceOngoingError
    | AbsenceChangedConcurrentlyError>
}>()("ArchiveAbsenceService") {
  static layer = Layer.effect(ArchiveAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const domainEvents = yield* DomainEvents
    return ArchiveAbsenceService.of({
      archiveAbsence: Effect.fn("ArchiveAbsenceService.archiveAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findActiveAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(Absence.decide({ absence, command: ArchiveAbsenceCommand.make({ actor }), now }))
        yield* absenceRepository.updateAbsence({ before: absence, after: Absence.evolve({ absence, event }) })
        yield* domainEvents.publishDomainEvent(event)
      }),
    })
  }))
}
