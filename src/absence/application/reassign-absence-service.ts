import { Context, DateTime, Effect, Layer } from "effect"
import type { OrganizationId, UserId } from "../../shared/ids.ts"
import { OrganizationMembers } from "../../shared/organization-members.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import type {
  AbsenceAlreadyArchivedError, AbsenceChangedConcurrentlyError, AbsenceEditWindowClosedError, AbsenceNotFoundError,
  AssigneeNotInOrganizationError, NotAllowedToAssignAbsenceError, NotAllowedToEditAbsenceError,
} from "../domain/absence-error.ts"
import type { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"
import { reassignAbsence } from "../domain/absence.ts"

export type ReassignAbsenceCommand = {
  readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId; readonly assigneeId: UserId
}

export class ReassignAbsenceService extends Context.Service<ReassignAbsenceService, {
  reassignAbsence(command: ReassignAbsenceCommand): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyArchivedError
    | NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError
    | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError
    | AbsenceChangedConcurrentlyError>
}>()("ReassignAbsenceService") {
  static layer = Layer.effect(ReassignAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const organizationMembers = yield* OrganizationMembers
    return ReassignAbsenceService.of({
      reassignAbsence: Effect.fn("ReassignAbsenceService.reassignAbsence")(function* ({ organizationId, actor, absenceId, assigneeId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findEditableAbsenceById({ organizationId, absenceId })
        // after the find, so a missing absence is 404 before anything about the assignee
        const assigneeIsOrganizationMember = yield* organizationMembers.isOrganizationMember({ organizationId, userId: assigneeId })
        const event = yield* Effect.fromResult(reassignAbsence({ absence, actor, assigneeId, assigneeIsOrganizationMember, now }))
        yield* absenceRepository.publishAbsenceEvent(event)
      }),
    })
  }))
}
