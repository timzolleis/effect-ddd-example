import { Context, DateTime, Effect, Layer } from "effect"
import { DomainEvents } from "../../shared/domain-events.ts"
import type { OrganizationId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import { Absence, WithdrawAbsenceCommand } from "../domain/absence.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError, NotAllowedToDeleteAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"

export type WithdrawAbsenceRequest = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class WithdrawAbsenceService extends Context.Service<WithdrawAbsenceService, {
  withdrawAbsence(request: WithdrawAbsenceRequest): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyArchivedError
    | NotAllowedToDeleteAbsenceError
    | AbsenceChangedConcurrentlyError>
}>()("WithdrawAbsenceService") {
  static layer = Layer.effect(WithdrawAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const domainEvents = yield* DomainEvents
    return WithdrawAbsenceService.of({
      withdrawAbsence: Effect.fn("WithdrawAbsenceService.withdrawAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findEditableAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(Absence.decide({ absence, command: WithdrawAbsenceCommand.make({ actor }), now }))
        yield* absenceRepository.updateAbsence({ before: absence, after: Absence.evolve({ absence, event }) })
        yield* domainEvents.publishDomainEvent(event)
      }),
    })
  }))
}
