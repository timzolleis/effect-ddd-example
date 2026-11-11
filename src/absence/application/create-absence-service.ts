import { Context, DateTime, Effect, Layer } from "effect"
import { DomainEvents } from "../../shared/domain-events.ts"
import type { OrganizationId, UserId } from "../../shared/ids.ts"
import { OrganizationMembers } from "../../shared/organization-members.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"
import type {
  AbsenceChangedConcurrentlyError, AssigneeNotInOrganizationError, InvalidPeriodError, NotAllowedToAssignAbsenceError,
} from "../domain/absence-error.ts"
import { generateAbsenceId, type AbsenceId } from "../domain/absence-id.ts"
import { AbsenceRepository } from "../domain/absence-repository.ts"
import { createAbsence, initialAbsence } from "../domain/absence.ts"

export type CreateAbsenceCommand = {
  readonly organizationId: OrganizationId
  readonly actor: AbsenceActor
  readonly absenceId?: AbsenceId | undefined   // client-sent (optimistic UI, idempotent retry); else generated
  readonly assigneeId: UserId
  readonly from: DateTime.Utc
  readonly to: DateTime.Utc
}

export class CreateAbsenceService extends Context.Service<CreateAbsenceService, {
  createAbsence(command: CreateAbsenceCommand): Effect.Effect<AbsenceId,
    | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError
    | AbsenceChangedConcurrentlyError>
}>()("CreateAbsenceService") {
  static layer = Layer.effect(CreateAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const domainEvents = yield* DomainEvents
    const organizationMembers = yield* OrganizationMembers
    return CreateAbsenceService.of({
      createAbsence: Effect.fn("CreateAbsenceService.createAbsence")(function* ({ organizationId, actor, absenceId: requestedAbsenceId, assigneeId, from, to }) {
        const now = yield* DateTime.now
        const absenceId = requestedAbsenceId ?? generateAbsenceId()
        // loaded every time, even when the actor may assign anyone: skipping it would move the rule here
        const assigneeIsOrganizationMember = yield* organizationMembers.isOrganizationMember({ organizationId, userId: assigneeId })
        const event = yield* Effect.fromResult(createAbsence({ absenceId, organizationId, actor, assigneeId, assigneeIsOrganizationMember, from, to, now }))
        yield* absenceRepository.insertAbsence({ after: initialAbsence(event) })
        yield* domainEvents.publishDomainEvent(event)
        return absenceId
      }),
    })
  }))
}
