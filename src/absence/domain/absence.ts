import { DateTime, Result, Schema } from "effect"
import { OrganizationId, UserId } from "../../shared/ids.ts"
import type { AbsenceActor } from "./absence-actor.ts"
import type {
  AbsenceEditWindowClosedError, AbsenceOngoingError, AssigneeNotInOrganizationError, InvalidPeriodError,
  NotAbsenceCreatorError, NotAllowedToAssignAbsenceError, NotAllowedToDeleteAbsenceError, NotAllowedToEditAbsenceError,
} from "./absence-error.ts"
import {
  AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDeletedEvent, AbsenceDraftedEvent,
  AbsenceReassignedEvent, AbsenceRescheduledEvent,
} from "./absence-event.ts"
import { AbsenceId } from "./absence-id.ts"
import {
  activateAbsencePolicies, archiveAbsencePolicies, checkPolicies, createAbsencePolicies,
  deleteAbsencePolicies, reassignAbsencePolicies, rescheduleAbsencePolicies,
} from "./absence-policy.ts"
import { createPeriod, Period } from "./period.ts"

const absenceFields = {
  absenceId: AbsenceId, organizationId: OrganizationId, creatorId: UserId, assigneeId: UserId,
  period: Period, createdAt: Schema.DateTimeUtc,
}

export const DraftAbsence = Schema.TaggedStruct("DraftAbsence", { ...absenceFields })
export type DraftAbsence = typeof DraftAbsence.Type

export const ActiveAbsence = Schema.TaggedStruct("ActiveAbsence", { ...absenceFields, activatedAt: Schema.DateTimeUtc })
export type ActiveAbsence = typeof ActiveAbsence.Type

export const ArchivedAbsence = Schema.TaggedStruct("ArchivedAbsence", {
  ...absenceFields, activatedAt: Schema.DateTimeUtc, archivedAt: Schema.DateTimeUtc,
})
export type ArchivedAbsence = typeof ArchivedAbsence.Type

export type Absence = DraftAbsence | ActiveAbsence | ArchivedAbsence   // nothing decodes to it
export type EditableAbsence = DraftAbsence | ActiveAbsence

// The transition and its policies take the same input type.
export type CreateAbsenceInput = {
  readonly absenceId: AbsenceId; readonly organizationId: OrganizationId; readonly actor: AbsenceActor
  readonly assigneeId: UserId; readonly assigneeIsOrganizationMember: boolean
  readonly from: DateTime.Utc; readonly to: DateTime.Utc; readonly now: DateTime.Utc
}
export type RescheduleAbsenceInput = {
  readonly absence: EditableAbsence; readonly actor: AbsenceActor
  readonly from: DateTime.Utc; readonly to: DateTime.Utc; readonly now: DateTime.Utc
}
export type ReassignAbsenceInput = {
  readonly absence: EditableAbsence; readonly actor: AbsenceActor
  readonly assigneeId: UserId; readonly assigneeIsOrganizationMember: boolean; readonly now: DateTime.Utc
}
export type ActivateAbsenceInput = { readonly absence: DraftAbsence; readonly actor: AbsenceActor; readonly now: DateTime.Utc }
export type ArchiveAbsenceInput = { readonly absence: ActiveAbsence; readonly actor: AbsenceActor; readonly now: DateTime.Utc }
export type DeleteAbsenceInput = { readonly absence: EditableAbsence; readonly actor: AbsenceActor; readonly now: DateTime.Utc }

export const createAbsence = (input: CreateAbsenceInput): Result.Result<
  AbsenceDraftedEvent, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError
> => Result.gen(function* () {
  yield* checkPolicies(createAbsencePolicies, input)
  const period = yield* createPeriod({ from: input.from, to: input.to })
  return AbsenceDraftedEvent.make({
    absenceId: input.absenceId, organizationId: input.organizationId, actorId: input.actor.userId, occurredOn: input.now,
    creatorId: input.actor.userId, assigneeId: input.assigneeId, period,
  })
})

export const rescheduleAbsence = (input: RescheduleAbsenceInput): Result.Result<
  AbsenceRescheduledEvent, NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError | InvalidPeriodError
> => Result.gen(function* () {
  yield* checkPolicies(rescheduleAbsencePolicies, input)
  const period = yield* createPeriod({ from: input.from, to: input.to })
  return AbsenceRescheduledEvent.make({
    absenceId: input.absence.absenceId, organizationId: input.absence.organizationId, actorId: input.actor.userId,
    occurredOn: input.now, period, previousPeriod: input.absence.period,
  })
})

export const reassignAbsence = (input: ReassignAbsenceInput): Result.Result<
  AbsenceReassignedEvent,
  NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError
> => Result.gen(function* () {
  yield* checkPolicies(reassignAbsencePolicies, input)
  return AbsenceReassignedEvent.make({
    absenceId: input.absence.absenceId, organizationId: input.absence.organizationId, actorId: input.actor.userId,
    occurredOn: input.now, assigneeId: input.assigneeId, previousAssigneeId: input.absence.assigneeId,
  })
})

export const activateAbsence = (input: ActivateAbsenceInput): Result.Result<AbsenceActivatedEvent, NotAbsenceCreatorError> =>
  Result.gen(function* () {
    yield* checkPolicies(activateAbsencePolicies, input)
    return AbsenceActivatedEvent.make({
      absenceId: input.absence.absenceId, organizationId: input.absence.organizationId, actorId: input.actor.userId,
      occurredOn: input.now,
    })
  })

export const archiveAbsence = (input: ArchiveAbsenceInput): Result.Result<
  AbsenceArchivedEvent, NotAllowedToEditAbsenceError | AbsenceOngoingError
> => Result.gen(function* () {
  yield* checkPolicies(archiveAbsencePolicies, input)
  return AbsenceArchivedEvent.make({
    absenceId: input.absence.absenceId, organizationId: input.absence.organizationId, actorId: input.actor.userId,
    occurredOn: input.now,
  })
})

export const deleteAbsence = (input: DeleteAbsenceInput): Result.Result<AbsenceDeletedEvent, NotAllowedToDeleteAbsenceError> =>
  Result.gen(function* () {
    yield* checkPolicies(deleteAbsencePolicies, input)
    return AbsenceDeletedEvent.make({
      absenceId: input.absence.absenceId, organizationId: input.absence.organizationId, actorId: input.actor.userId,
      occurredOn: input.now, assigneeId: input.absence.assigneeId, period: input.absence.period,
    })
  })
