import { Schema } from "effect"
import { Aggregate } from "../../lib/aggregate.ts"
import { OrganizationId, UserId } from "../../shared/ids.ts"
import { AbsenceActor } from "./absence-actor.ts"
import {
  AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDraftedEvent, AbsenceReassignedEvent, AbsenceRescheduledEvent,
  AbsenceWithdrawnEvent,
} from "./absence-event.ts"
import { AbsenceId } from "./absence-id.ts"
import {
  activateAbsence, ActiveAbsence, archiveAbsence, ArchivedAbsence, createAbsence, DiscardedAbsence, DraftAbsence, reassignAbsence,
  rescheduleAbsence, withdrawAbsence,
} from "./absence.ts"

// ─── Commands ───

export const DraftAbsenceCommand = Schema.TaggedStruct("DraftAbsenceCommand", {
  absenceId: AbsenceId, organizationId: OrganizationId, actor: AbsenceActor,
  assigneeId: UserId, assigneeIsOrganizationMember: Schema.Boolean, from: Schema.DateTimeUtc, to: Schema.DateTimeUtc,
})
export const RescheduleAbsenceCommand = Schema.TaggedStruct("RescheduleAbsenceCommand", {
  actor: AbsenceActor, from: Schema.DateTimeUtc, to: Schema.DateTimeUtc,
})
export const ReassignAbsenceCommand = Schema.TaggedStruct("ReassignAbsenceCommand", {
  actor: AbsenceActor, assigneeId: UserId, assigneeIsOrganizationMember: Schema.Boolean,
})
export const ActivateAbsenceCommand = Schema.TaggedStruct("ActivateAbsenceCommand", { actor: AbsenceActor })
export const ArchiveAbsenceCommand  = Schema.TaggedStruct("ArchiveAbsenceCommand",  { actor: AbsenceActor })
export const WithdrawAbsenceCommand = Schema.TaggedStruct("WithdrawAbsenceCommand", { actor: AbsenceActor })

export type DraftAbsenceCommand      = typeof DraftAbsenceCommand.Type
export type RescheduleAbsenceCommand = typeof RescheduleAbsenceCommand.Type
export type ReassignAbsenceCommand   = typeof ReassignAbsenceCommand.Type
export type ActivateAbsenceCommand   = typeof ActivateAbsenceCommand.Type
export type ArchiveAbsenceCommand    = typeof ArchiveAbsenceCommand.Type
export type WithdrawAbsenceCommand   = typeof WithdrawAbsenceCommand.Type

export const Absence = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence, DiscardedAbsence },
  commands: {
    DraftAbsenceCommand, RescheduleAbsenceCommand, ReassignAbsenceCommand, ActivateAbsenceCommand, ArchiveAbsenceCommand, WithdrawAbsenceCommand,
  },
  events: {
    AbsenceDraftedEvent, AbsenceRescheduledEvent, AbsenceReassignedEvent, AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceWithdrawnEvent,
  },

  handlers: {
    // ─── Start ───
    start: {
      decide: {
        DraftAbsenceCommand: ({ command, now }) => createAbsence({ ...command, now }),
      },
      evolve: {
        AbsenceDraftedEvent: ({ event }) => DraftAbsence.make({
          absenceId: event.absenceId, organizationId: event.organizationId, creatorId: event.creatorId,
          assigneeId: event.assigneeId, period: event.period, createdAt: event.occurredOn, updatedAt: event.occurredOn,
        }),
      },
    },

    // ─── Draft ───
    DraftAbsence: {
      decide: {
        RescheduleAbsenceCommand: ({ absence, command, now }) => rescheduleAbsence({ absence, ...command, now }),
        ReassignAbsenceCommand:   ({ absence, command, now }) => reassignAbsence({ absence, ...command, now }),
        ActivateAbsenceCommand:   ({ absence, command, now }) => activateAbsence({ absence, ...command, now }),
        WithdrawAbsenceCommand:   ({ absence, command, now }) => withdrawAbsence({ absence, ...command, now }),
      },
      evolve: {
        AbsenceRescheduledEvent: ({ absence, event }) => DraftAbsence.make({ ...absence, period: event.period, updatedAt: event.occurredOn }),
        AbsenceReassignedEvent:  ({ absence, event }) => DraftAbsence.make({ ...absence, assigneeId: event.assigneeId, updatedAt: event.occurredOn }),
        AbsenceActivatedEvent:   ({ absence, event }) => ActiveAbsence.make({
          ...absence, _tag: "ActiveAbsence", activatedAt: event.occurredOn, updatedAt: event.occurredOn,
        }),
        AbsenceWithdrawnEvent:   ({ absence, event }) => DiscardedAbsence.make({
          ...absence, _tag: "DiscardedAbsence", archivedAt: event.occurredOn, updatedAt: event.occurredOn,
        }),
      },
    },

    // ─── Active ───
    ActiveAbsence: {
      decide: {
        RescheduleAbsenceCommand: ({ absence, command, now }) => rescheduleAbsence({ absence, ...command, now }),
        ReassignAbsenceCommand:   ({ absence, command, now }) => reassignAbsence({ absence, ...command, now }),
        ArchiveAbsenceCommand:    ({ absence, command, now }) => archiveAbsence({ absence, ...command, now }),
        WithdrawAbsenceCommand:   ({ absence, command, now }) => withdrawAbsence({ absence, ...command, now }),
      },
      evolve: {
        AbsenceRescheduledEvent: ({ absence, event }) => ActiveAbsence.make({ ...absence, period: event.period, updatedAt: event.occurredOn }),
        AbsenceReassignedEvent:  ({ absence, event }) => ActiveAbsence.make({ ...absence, assigneeId: event.assigneeId, updatedAt: event.occurredOn }),
        AbsenceArchivedEvent:    ({ absence, event }) => ArchivedAbsence.make({
          ...absence, _tag: "ArchivedAbsence", archivedAt: event.occurredOn, updatedAt: event.occurredOn,
        }),
        AbsenceWithdrawnEvent:   ({ absence, event }) => ArchivedAbsence.make({
          ...absence, _tag: "ArchivedAbsence", archivedAt: event.occurredOn, updatedAt: event.occurredOn,
        }),
      },
    },

    // ─── Archived, Discarded ───
    ArchivedAbsence: {},
    DiscardedAbsence: {},
  },
})

export type AbsenceEvent = Aggregate.Event<typeof Absence>
