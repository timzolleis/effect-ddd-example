import { Result, Schema } from "effect"
import { Aggregate } from "../../lib/aggregate.ts"
import { OrganizationId, UserId } from "../../shared/ids.ts"
import { AbsenceActor } from "./absence-actor.ts"
import { AbsenceId } from "./absence-id.ts"
import {
  assigneeMustBeInOrganizationPolicy, assigneeMustBeSelfOrRelatedPolicy, cannotArchiveWhileOngoingPolicy, checkPolicies, editOnlyInFirstHourPolicy,
  onlyCreatorCanActivatePolicy, onlyCreatorOrPermittedCanDeletePolicy, onlyCreatorOrPermittedCanEditPolicy,
} from "./absence-policy.ts"
import { createPeriod, Period } from "./period.ts"

const absenceFields = {
  absenceId: AbsenceId, organizationId: OrganizationId, creatorId: UserId, assigneeId: UserId, period: Period,
  createdAt: Schema.DateTimeUtc, updatedAt: Schema.DateTimeUtc,
}
const absenceEventFields = { absenceId: AbsenceId, organizationId: OrganizationId, actorId: UserId, occurredOn: Schema.DateTimeUtc }

export class DraftAbsence     extends Schema.Opaque<DraftAbsence>()(Schema.TaggedStruct("DraftAbsence",     { ...absenceFields })) {}
export class ActiveAbsence    extends Schema.Opaque<ActiveAbsence>()(Schema.TaggedStruct("ActiveAbsence",    { ...absenceFields, activatedAt: Schema.DateTimeUtc })) {}
export class ArchivedAbsence  extends Schema.Opaque<ArchivedAbsence>()(Schema.TaggedStruct("ArchivedAbsence",  { ...absenceFields, activatedAt: Schema.DateTimeUtc, archivedAt: Schema.DateTimeUtc })) {}
export class DiscardedAbsence extends Schema.Opaque<DiscardedAbsence>()(Schema.TaggedStruct("DiscardedAbsence", { ...absenceFields, archivedAt: Schema.DateTimeUtc })) {}

export class DraftAbsenceCommand      extends Schema.Opaque<DraftAbsenceCommand>()(Schema.TaggedStruct("DraftAbsenceCommand",      {
  absenceId: AbsenceId, organizationId: OrganizationId, actor: AbsenceActor, assigneeId: UserId, assigneeIsOrganizationMember: Schema.Boolean,
  from: Schema.DateTimeUtc, to: Schema.DateTimeUtc,
})) {}
export class RescheduleAbsenceCommand extends Schema.Opaque<RescheduleAbsenceCommand>()(Schema.TaggedStruct("RescheduleAbsenceCommand", { actor: AbsenceActor, from: Schema.DateTimeUtc, to: Schema.DateTimeUtc })) {}
export class ReassignAbsenceCommand   extends Schema.Opaque<ReassignAbsenceCommand>()(Schema.TaggedStruct("ReassignAbsenceCommand",   { actor: AbsenceActor, assigneeId: UserId, assigneeIsOrganizationMember: Schema.Boolean })) {}
export class ActivateAbsenceCommand   extends Schema.Opaque<ActivateAbsenceCommand>()(Schema.TaggedStruct("ActivateAbsenceCommand",   { actor: AbsenceActor })) {}
export class ArchiveAbsenceCommand    extends Schema.Opaque<ArchiveAbsenceCommand>()(Schema.TaggedStruct("ArchiveAbsenceCommand",    { actor: AbsenceActor })) {}
export class WithdrawAbsenceCommand   extends Schema.Opaque<WithdrawAbsenceCommand>()(Schema.TaggedStruct("WithdrawAbsenceCommand",   { actor: AbsenceActor })) {}

export class AbsenceDraftedEvent     extends Schema.Opaque<AbsenceDraftedEvent>()(Schema.TaggedStruct("AbsenceDraftedEvent",     { ...absenceEventFields, creatorId: UserId, assigneeId: UserId, period: Period })) {}
export class AbsenceRescheduledEvent extends Schema.Opaque<AbsenceRescheduledEvent>()(Schema.TaggedStruct("AbsenceRescheduledEvent", { ...absenceEventFields, period: Period, previousPeriod: Period })) {}
export class AbsenceReassignedEvent  extends Schema.Opaque<AbsenceReassignedEvent>()(Schema.TaggedStruct("AbsenceReassignedEvent",  { ...absenceEventFields, assigneeId: UserId, previousAssigneeId: UserId })) {}
export class AbsenceActivatedEvent   extends Schema.Opaque<AbsenceActivatedEvent>()(Schema.TaggedStruct("AbsenceActivatedEvent",   { ...absenceEventFields })) {}
export class AbsenceArchivedEvent    extends Schema.Opaque<AbsenceArchivedEvent>()(Schema.TaggedStruct("AbsenceArchivedEvent",    { ...absenceEventFields })) {}
export class AbsenceWithdrawnEvent   extends Schema.Opaque<AbsenceWithdrawnEvent>()(Schema.TaggedStruct("AbsenceWithdrawnEvent",   { ...absenceEventFields })) {}

export type EditableAbsence = DraftAbsence | ActiveAbsence

export const Absence = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence, DiscardedAbsence },
  commands: {
    DraftAbsenceCommand, RescheduleAbsenceCommand, ReassignAbsenceCommand, ActivateAbsenceCommand, ArchiveAbsenceCommand, WithdrawAbsenceCommand,
  },

  handlers: {
    DraftAbsenceCommand: {
      from: ["initial"],
      event: AbsenceDraftedEvent,
      decide: ({ command, now }) => Result.gen(function* () {
        yield* checkPolicies([assigneeMustBeInOrganizationPolicy, assigneeMustBeSelfOrRelatedPolicy], {
          actor: command.actor, assigneeId: command.assigneeId, assigneeIsOrganizationMember: command.assigneeIsOrganizationMember,
        })
        const period = yield* createPeriod({ from: command.from, to: command.to })
        return AbsenceDraftedEvent.make({
          absenceId: command.absenceId, organizationId: command.organizationId, actorId: command.actor.userId, occurredOn: now,
          creatorId: command.actor.userId, assigneeId: command.assigneeId, period,
        })
      }),
      evolve: {
        initial: ({ event }) => DraftAbsence.make({
          absenceId: event.absenceId, organizationId: event.organizationId, creatorId: event.creatorId,
          assigneeId: event.assigneeId, period: event.period, createdAt: event.occurredOn, updatedAt: event.occurredOn,
        }),
      },
    },

    RescheduleAbsenceCommand: {
      from: [DraftAbsence, ActiveAbsence],
      event: AbsenceRescheduledEvent,
      decide: ({ absence, command, now }) => Result.gen(function* () {
        yield* checkPolicies([onlyCreatorOrPermittedCanEditPolicy, editOnlyInFirstHourPolicy], { absence, actor: command.actor, now })
        const period = yield* createPeriod({ from: command.from, to: command.to })
        return AbsenceRescheduledEvent.make({
          absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId, occurredOn: now,
          period, previousPeriod: absence.period,
        })
      }),
      evolve: {
        DraftAbsence:  ({ absence, event }) => DraftAbsence.make({ ...absence, period: event.period, updatedAt: event.occurredOn }),
        ActiveAbsence: ({ absence, event }) => ActiveAbsence.make({ ...absence, period: event.period, updatedAt: event.occurredOn }),
      },
    },

    ReassignAbsenceCommand: {
      from: [DraftAbsence, ActiveAbsence],
      event: AbsenceReassignedEvent,
      decide: ({ absence, command, now }) => Result.gen(function* () {
        yield* checkPolicies(
          [onlyCreatorOrPermittedCanEditPolicy, assigneeMustBeInOrganizationPolicy, assigneeMustBeSelfOrRelatedPolicy, editOnlyInFirstHourPolicy],
          { absence, actor: command.actor, assigneeId: command.assigneeId, assigneeIsOrganizationMember: command.assigneeIsOrganizationMember, now },
        )
        return AbsenceReassignedEvent.make({
          absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId, occurredOn: now,
          assigneeId: command.assigneeId, previousAssigneeId: absence.assigneeId,
        })
      }),
      evolve: {
        DraftAbsence:  ({ absence, event }) => DraftAbsence.make({ ...absence, assigneeId: event.assigneeId, updatedAt: event.occurredOn }),
        ActiveAbsence: ({ absence, event }) => ActiveAbsence.make({ ...absence, assigneeId: event.assigneeId, updatedAt: event.occurredOn }),
      },
    },

    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: ({ absence, command, now }) => Result.gen(function* () {
        yield* checkPolicies([onlyCreatorCanActivatePolicy], { absence, actor: command.actor, now })
        return AbsenceActivatedEvent.make({
          absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId, occurredOn: now,
        })
      }),
      evolve: {
        DraftAbsence: ({ absence, event }) => ActiveAbsence.make({ ...absence, activatedAt: event.occurredOn, updatedAt: event.occurredOn }),
      },
    },

    ArchiveAbsenceCommand: {
      from: [ActiveAbsence],
      event: AbsenceArchivedEvent,
      decide: ({ absence, command, now }) => Result.gen(function* () {
        yield* checkPolicies([onlyCreatorOrPermittedCanEditPolicy, cannotArchiveWhileOngoingPolicy], { absence, actor: command.actor, now })
        return AbsenceArchivedEvent.make({
          absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId, occurredOn: now,
        })
      }),
      evolve: {
        ActiveAbsence: ({ absence, event }) => ArchivedAbsence.make({ ...absence, archivedAt: event.occurredOn, updatedAt: event.occurredOn }),
      },
    },

    WithdrawAbsenceCommand: {
      from: [DraftAbsence, ActiveAbsence],
      event: AbsenceWithdrawnEvent,
      decide: ({ absence, command, now }) => Result.gen(function* () {
        yield* checkPolicies([onlyCreatorOrPermittedCanDeletePolicy], { absence, actor: command.actor, now })
        return AbsenceWithdrawnEvent.make({
          absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId, occurredOn: now,
        })
      }),
      evolve: {
        DraftAbsence:  ({ absence, event }) => DiscardedAbsence.make({ ...absence, archivedAt: event.occurredOn, updatedAt: event.occurredOn }),
        ActiveAbsence: ({ absence, event }) => ArchivedAbsence.make({ ...absence, archivedAt: event.occurredOn, updatedAt: event.occurredOn }),
      },
    },
  },
})

export type Absence = Aggregate.State<typeof Absence>
export type AbsenceEvent = Aggregate.Event<typeof Absence>
