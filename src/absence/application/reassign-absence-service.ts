import { Context, DateTime, Effect, Layer } from "effect"
import { DomainEvents } from "../../shared/domain-events.ts"
import type { OrganizationId, UserId } from "../../shared/ids.ts"
import { OrganizationMembers } from "../../shared/organization-members.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import { Absence, ReassignAbsenceCommand } from "../domain/absence-aggregate.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceEditWindowClosedError, AbsenceNotFoundError,
  AssigneeNotInOrganizationError, NotAllowedToAssignAbsenceError, NotAllowedToEditAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"

export type ReassignAbsenceRequest = {
  readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId; readonly assigneeId: UserId
}

export class ReassignAbsenceService extends Context.Service<ReassignAbsenceService, {
  reassignAbsence(request: ReassignAbsenceRequest): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyArchivedError
    | NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError
    | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError
    | AbsenceChangedConcurrentlyError>
}>()("ReassignAbsenceService") {
  static layer = Layer.effect(ReassignAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const domainEvents = yield* DomainEvents
    const organizationMembers = yield* OrganizationMembers
    return ReassignAbsenceService.of({
      reassignAbsence: Effect.fn("ReassignAbsenceService.reassignAbsence")(function* ({ organizationId, actor, absenceId, assigneeId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findEditableAbsenceById({ organizationId, absenceId })
        // after the find, so a missing absence is 404 before anything about the assignee
        const assigneeIsOrganizationMember = yield* organizationMembers.isOrganizationMember({ organizationId, userId: assigneeId })
        const command = ReassignAbsenceCommand.make({ actor, assigneeId, assigneeIsOrganizationMember })
        const event = yield* Effect.fromResult(Absence.decide({ absence, command, now }))
        yield* absenceRepository.updateAbsence({ before: absence, after: Absence.evolve({ absence, event }) })
        yield* domainEvents.publishDomainEvent(event)
      }),
    })
  }))
}
