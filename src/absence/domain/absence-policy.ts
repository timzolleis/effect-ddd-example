import { DateTime, Match, Result } from "effect"
import type { UserId } from "../../shared/ids.ts"
import type { AbsenceActor } from "./absence-actor.ts"
import {
  AbsenceEditWindowClosedError, AbsenceOngoingError, AssigneeNotInOrganizationError, NotAbsenceCreatorError,
  NotAllowedToAssignAbsenceError, NotAllowedToDeleteAbsenceError, NotAllowedToEditAbsenceError,
} from "./absence-error.ts"
import type { ActiveAbsence, DraftAbsence, EditableAbsence } from "./absence.ts"
import { isPeriodOngoingAt } from "./period.ts"

type PolicyError<Policy> = Policy extends (input: never) => Result.Result<void, infer Error> ? Error : never

// The first rejection wins.
export const checkPolicies = <Input, const Policies extends ReadonlyArray<(input: NoInfer<Input>) => Result.Result<void, unknown>>>(
  policies: Policies,
  input: Input,
): Result.Result<void, PolicyError<Policies[number]>> => {
  for (const policy of policies) {
    const policyResult = policy(input)
    // Cast: the failure holds the error of this policy, one member of PolicyError<Policies[number]>; the loop variable lost which.
    if (Result.isFailure(policyResult)) return policyResult as Result.Result<void, PolicyError<Policies[number]>>
  }
  return Result.succeed(undefined)
}

const isActingUser = (input: { readonly actor: AbsenceActor; readonly userId: UserId }) => input.userId === input.actor.userId
const isAbsenceCreator = (input: { readonly absence: EditableAbsence; readonly actor: AbsenceActor }) =>
  isActingUser({ actor: input.actor, userId: input.absence.creatorId })
const isRelatedToActor = (input: { readonly actor: AbsenceActor; readonly userId: UserId }) =>
  input.actor.relatedUserIds.has(input.userId)

export const onlyCreatorCanActivatePolicy = (input: { readonly absence: DraftAbsence; readonly actor: AbsenceActor }) =>
  isAbsenceCreator(input)
    ? Result.succeed(undefined)
    : Result.fail(new NotAbsenceCreatorError({ absenceId: input.absence.absenceId, actorId: input.actor.userId }))

export const onlyCreatorOrPermittedCanEditPolicy = (input: { readonly absence: EditableAbsence; readonly actor: AbsenceActor }) => {
  const notAllowedToEditAbsence = () => Result.fail(new NotAllowedToEditAbsenceError({
    absenceId: input.absence.absenceId, actorId: input.actor.userId, absenceState: input.absence._tag,
  }))
  return Match.valueTags(input.absence, {
    DraftAbsence: () => isAbsenceCreator(input) ? Result.succeed(undefined) : notAllowedToEditAbsence(),
    ActiveAbsence: () => isAbsenceCreator(input) || input.actor.mayEditOthersAbsences ? Result.succeed(undefined) : notAllowedToEditAbsence(),
  })
}

export const onlyCreatorOrPermittedCanDeletePolicy = (input: { readonly absence: EditableAbsence; readonly actor: AbsenceActor }) => {
  const notAllowedToDeleteAbsence = () => Result.fail(new NotAllowedToDeleteAbsenceError({
    absenceId: input.absence.absenceId, actorId: input.actor.userId, absenceState: input.absence._tag,
  }))
  return Match.valueTags(input.absence, {
    DraftAbsence: () => isAbsenceCreator(input) ? Result.succeed(undefined) : notAllowedToDeleteAbsence(),
    ActiveAbsence: () => isAbsenceCreator(input) || input.actor.mayDeleteOthersAbsences ? Result.succeed(undefined) : notAllowedToDeleteAbsence(),
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

export const cannotArchiveWhileOngoingPolicy = (input: { readonly absence: ActiveAbsence; readonly now: DateTime.Utc }) =>
  isPeriodOngoingAt({ period: input.absence.period, now: input.now })
    ? Result.fail(new AbsenceOngoingError({ absenceId: input.absence.absenceId, period: input.absence.period }))
    : Result.succeed(undefined)
