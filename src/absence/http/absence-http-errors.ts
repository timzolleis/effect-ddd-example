import { Effect, Schema } from "effect"
import { matchTag } from "../../lib/match-tag.ts"
import type { AbsenceError } from "../domain/absence-error.ts"

export class AbsenceNotFoundHttpError extends Schema.TaggedError<AbsenceNotFoundHttpError>()("AbsenceNotFoundHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("This absence doesn't exist or isn't visible to you."))),
}, { httpApiStatus: 404 }) {}

export class AbsenceStillDraftHttpError extends Schema.TaggedError<AbsenceStillDraftHttpError>()("AbsenceStillDraftHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("This absence is still a draft. Activate it first."))),
}, { httpApiStatus: 409 }) {}

export class AbsenceAlreadyActiveHttpError extends Schema.TaggedError<AbsenceAlreadyActiveHttpError>()("AbsenceAlreadyActiveHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("This absence is already active."))),
}, { httpApiStatus: 409 }) {}

export class AbsenceAlreadyArchivedHttpError extends Schema.TaggedError<AbsenceAlreadyArchivedHttpError>()("AbsenceAlreadyArchivedHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("This absence is archived and can't be changed."))),
}, { httpApiStatus: 409 }) {}

export class NotAbsenceCreatorHttpError extends Schema.TaggedError<NotAbsenceCreatorHttpError>()("NotAbsenceCreatorHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("Only the creator of this absence can activate it."))),
}, { httpApiStatus: 403 }) {}

export class NotAllowedToEditAbsenceHttpError extends Schema.TaggedError<NotAllowedToEditAbsenceHttpError>()("NotAllowedToEditAbsenceHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("Only the creator can change this absence. Once it's active, people with the absences:update permission can too."))),
}, { httpApiStatus: 403 }) {}

export class NotAllowedToDeleteAbsenceHttpError extends Schema.TaggedError<NotAllowedToDeleteAbsenceHttpError>()("NotAllowedToDeleteAbsenceHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("Only the creator can delete this absence. Once it's active, people with the absences:delete permission can too."))),
}, { httpApiStatus: 403 }) {}

export class AssigneeNotInOrganizationHttpError extends Schema.TaggedError<AssigneeNotInOrganizationHttpError>()("AssigneeNotInOrganizationHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("The assignee isn't a member of this organization."))),
}, { httpApiStatus: 422 }) {}

export class NotAllowedToAssignAbsenceHttpError extends Schema.TaggedError<NotAllowedToAssignAbsenceHttpError>()("NotAllowedToAssignAbsenceHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("You can assign absences to yourself and to people you're responsible for. Assigning others needs the absences:update permission."))),
}, { httpApiStatus: 403 }) {}

export class AbsenceEditWindowClosedHttpError extends Schema.TaggedError<AbsenceEditWindowClosedHttpError>()("AbsenceEditWindowClosedHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("Absences can only be edited within one hour of creation."))),
}, { httpApiStatus: 409 }) {}

export class AbsenceOngoingHttpError extends Schema.TaggedError<AbsenceOngoingHttpError>()("AbsenceOngoingHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("This absence is in progress. Archive it after it ends."))),
}, { httpApiStatus: 409 }) {}

export class InvalidPeriodHttpError extends Schema.TaggedError<InvalidPeriodHttpError>()("InvalidPeriodHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("The start must be before the end."))),
}, { httpApiStatus: 422 }) {}

export class AbsenceChangedConcurrentlyHttpError extends Schema.TaggedError<AbsenceChangedConcurrentlyHttpError>()("AbsenceChangedConcurrentlyHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("Someone else changed this absence. Reload and try again."))),
}, { httpApiStatus: 409 }) {}

export class AbsenceAlreadyExistsHttpError extends Schema.TaggedError<AbsenceAlreadyExistsHttpError>()("AbsenceAlreadyExistsHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("An absence with this id already exists."))),
}, { httpApiStatus: 409 }) {}

export const absenceHttpErrorFromAbsenceError = matchTag<AbsenceError>()({
  AbsenceNotFoundError: () => new AbsenceNotFoundHttpError(),
  AbsenceStillDraftError: () => new AbsenceStillDraftHttpError(),
  AbsenceAlreadyActiveError: () => new AbsenceAlreadyActiveHttpError(),
  AbsenceAlreadyArchivedError: () => new AbsenceAlreadyArchivedHttpError(),
  NotAbsenceCreatorError: () => new NotAbsenceCreatorHttpError(),
  NotAllowedToEditAbsenceError: () => new NotAllowedToEditAbsenceHttpError(),
  NotAllowedToDeleteAbsenceError: () => new NotAllowedToDeleteAbsenceHttpError(),
  AssigneeNotInOrganizationError: () => new AssigneeNotInOrganizationHttpError(),
  NotAllowedToAssignAbsenceError: () => new NotAllowedToAssignAbsenceHttpError(),
  AbsenceEditWindowClosedError: () => new AbsenceEditWindowClosedHttpError(),
  AbsenceOngoingError: () => new AbsenceOngoingHttpError(),
  InvalidPeriodError: () => new InvalidPeriodHttpError(),
  AbsenceChangedConcurrentlyError: () => new AbsenceChangedConcurrentlyHttpError(),
  AbsenceAlreadyExistsError: () => new AbsenceAlreadyExistsHttpError(),
})
