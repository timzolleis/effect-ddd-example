import { DateTime, Match, Result } from "effect"
import type { UserId } from "../../shared/ids.ts"
import type { AbsenceActor } from "./absence-actor.ts"
import {
  AbsenceEditWindowClosedError, AbsenceOngoingError, AssigneeNotInOrganizationError, NotAbsenceCreatorError,
  NotAllowedToAssignAbsenceError, NotAllowedToDeleteAbsenceError, NotAllowedToEditAbsenceError,
} from "./absence-error.ts"
import type {
  Absence, ActivateAbsenceInput, ArchiveAbsenceInput, CreateAbsenceInput, DeleteAbsenceInput, DraftAbsence,
  EditableAbsence, ReassignAbsenceInput, RescheduleAbsenceInput,
} from "./absence.ts"
import { isPeriodOngoingAt } from "./period.ts"

// The first rejection wins.
export const checkPolicies = <Input, E>(
  policies: ReadonlyArray<(input: Input) => Result.Result<void, E>>,
  input: Input,
): Result.Result<void, E> => {
  for (const policy of policies) {
    const result = policy(input)
    if (Result.isFailure(result)) return result
  }
  return Result.succeed(undefined)
}

const isActingUser = (input: { readonly actor: AbsenceActor; readonly userId: UserId }) => input.userId === input.actor.userId
const isAbsenceCreator = (input: { readonly absence: Absence; readonly actor: AbsenceActor }) =>
  isActingUser({ actor: input.actor, userId: input.absence.creatorId })
const isRelatedToActor = (input: { readonly actor: AbsenceActor; readonly userId: UserId }) =>
  input.actor.relatedUserIds.has(input.userId)

export const onlyCreatorCanActivatePolicy = (input: { readonly absence: DraftAbsence; readonly actor: AbsenceActor }) =>
  isAbsenceCreator(input)
    ? Result.succeed(undefined)
    : Result.fail(new NotAbsenceCreatorError({ absenceId: input.absence.absenceId, actorId: input.actor.userId }))

export const onlyCreatorOrPermittedCanEditPolicy = (input: { readonly absence: EditableAbsence; readonly actor: AbsenceActor }) => {
  const notAllowed = () => Result.fail(new NotAllowedToEditAbsenceError({
    absenceId: input.absence.absenceId, actorId: input.actor.userId, absenceState: input.absence._tag,
  }))
  return Match.valueTags(input.absence, {
    DraftAbsence: () => isAbsenceCreator(input) ? Result.succeed(undefined) : notAllowed(),
    ActiveAbsence: () => isAbsenceCreator(input) || input.actor.mayEditOthersAbsences ? Result.succeed(undefined) : notAllowed(),
  })
}

export const onlyCreatorOrPermittedCanDeletePolicy = (input: { readonly absence: EditableAbsence; readonly actor: AbsenceActor }) => {
  const notAllowed = () => Result.fail(new NotAllowedToDeleteAbsenceError({
    absenceId: input.absence.absenceId, actorId: input.actor.userId, absenceState: input.absence._tag,
  }))
  return Match.valueTags(input.absence, {
    DraftAbsence: () => isAbsenceCreator(input) ? Result.succeed(undefined) : notAllowed(),
    ActiveAbsence: () => isAbsenceCreator(input) || input.actor.mayDeleteOthersAbsences ? Result.succeed(undefined) : notAllowed(),
  })
}

// A shared policy takes a subset of every input that lists it.
export const assigneeMustBeInOrganizationPolicy = (input: { readonly assigneeId: UserId; readonly assigneeIsOrganizationMember: boolean }) =>
  input.assigneeIsOrganizationMember
    ? Result.succeed(undefined)
    : Result.fail(new AssigneeNotInOrganizationError({ assigneeId: input.assigneeId }))

export const assigneeMustBeSelfOrRelatedPolicy = (input: { readonly actor: AbsenceActor; readonly assigneeId: UserId }) =>
  input.actor.mayAssignAnyone
    || isActingUser({ actor: input.actor, userId: input.assigneeId })
    || isRelatedToActor({ actor: input.actor, userId: input.assigneeId })
    ? Result.succeed(undefined)
    : Result.fail(new NotAllowedToAssignAbsenceError({ actorId: input.actor.userId, assigneeId: input.assigneeId }))

// one function for the instant the policy checks and the error reports
export const absenceEditableUntil = (absence: EditableAbsence): DateTime.Utc => DateTime.add(absence.createdAt, { hours: 1 })

export const editOnlyInFirstHourPolicy = (input: { readonly absence: EditableAbsence; readonly now: DateTime.Utc }) =>
  DateTime.isLessThanOrEqualTo(input.now, absenceEditableUntil(input.absence))
    ? Result.succeed(undefined)
    : Result.fail(new AbsenceEditWindowClosedError({
      absenceId: input.absence.absenceId, createdAt: input.absence.createdAt, editableUntil: absenceEditableUntil(input.absence),
    }))

// Per transition: a policy type and an ordered list. The order decides which rejection is reported.
export type CreateAbsencePolicy = (input: CreateAbsenceInput) =>
  Result.Result<void, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError>
export const createAbsencePolicies: ReadonlyArray<CreateAbsencePolicy> = [
  assigneeMustBeInOrganizationPolicy,
  assigneeMustBeSelfOrRelatedPolicy,
]

export type RescheduleAbsencePolicy = (input: RescheduleAbsenceInput) =>
  Result.Result<void, NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError>
export const rescheduleAbsencePolicies: ReadonlyArray<RescheduleAbsencePolicy> = [
  onlyCreatorOrPermittedCanEditPolicy,
  editOnlyInFirstHourPolicy,
]

export type ReassignAbsencePolicy = (input: ReassignAbsenceInput) => Result.Result<
  void, NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError
>
export const reassignAbsencePolicies: ReadonlyArray<ReassignAbsencePolicy> = [
  onlyCreatorOrPermittedCanEditPolicy, // may I touch this absence?
  assigneeMustBeInOrganizationPolicy,  // is the new assignee in the organization?
  assigneeMustBeSelfOrRelatedPolicy,   // may I give it to them?
  editOnlyInFirstHourPolicy,
]

export type ActivateAbsencePolicy = (input: ActivateAbsenceInput) => Result.Result<void, NotAbsenceCreatorError>
export const activateAbsencePolicies: ReadonlyArray<ActivateAbsencePolicy> = [onlyCreatorCanActivatePolicy]

export type ArchiveAbsencePolicy = (input: ArchiveAbsenceInput) => Result.Result<void, NotAllowedToEditAbsenceError | AbsenceOngoingError>
export const cannotArchiveWhileOngoingPolicy: ArchiveAbsencePolicy = (input) =>
  isPeriodOngoingAt({ period: input.absence.period, now: input.now })
    ? Result.fail(new AbsenceOngoingError({ absenceId: input.absence.absenceId, period: input.absence.period }))
    : Result.succeed(undefined)
export const archiveAbsencePolicies: ReadonlyArray<ArchiveAbsencePolicy> = [
  onlyCreatorOrPermittedCanEditPolicy,
  cannotArchiveWhileOngoingPolicy,
]

export type DeleteAbsencePolicy = (input: DeleteAbsenceInput) => Result.Result<void, NotAllowedToDeleteAbsenceError>
export const deleteAbsencePolicies: ReadonlyArray<DeleteAbsencePolicy> = [onlyCreatorOrPermittedCanDeletePolicy]
