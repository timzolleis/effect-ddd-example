import { Context, DateTime, Effect, Layer } from "effect"
import { DomainEventOutbox } from "../../shared/domain-events.ts"
import type { OrganizationId } from "../../shared/ids.ts"
import { Transactions } from "../../shared/transaction.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceNotFoundError, AbsenceOngoingError,
  AbsenceStillDraftError, NotAllowedToEditAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"
import { archiveAbsence, evolveAbsence } from "../domain/absence.ts"

export type ArchiveAbsenceCommand = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class ArchiveAbsenceService extends Context.Service<ArchiveAbsenceService, {
  archiveAbsence(command: ArchiveAbsenceCommand): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError
    | NotAllowedToEditAbsenceError | AbsenceOngoingError
    | AbsenceChangedConcurrentlyError>
}>()("ArchiveAbsenceService") {
  static layer = Layer.effect(ArchiveAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const domainEventOutbox = yield* DomainEventOutbox
    const transactions = yield* Transactions
    return ArchiveAbsenceService.of({
      archiveAbsence: Effect.fn("ArchiveAbsenceService.archiveAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findActiveAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(archiveAbsence({ absence, actor, now }))
        // atomic: the archive and its event commit together, or neither does
        yield* absenceRepository.updateAbsence({ before: absence, after: evolveAbsence({ absence, event }) }).pipe(
          Effect.andThen(domainEventOutbox.addDomainEvent(event)),
          transactions.runInTransaction,
        )
      }),
    })
  }))
}
