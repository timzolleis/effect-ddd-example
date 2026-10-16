import { Schema } from "effect"
import { OrganizationId, UserId } from "../../shared/ids.ts"
import { AbsenceId } from "./absence-id.ts"
import { Period } from "./period.ts"

// Never imports absence.ts: absence.ts imports this file to build events.
const absenceEventFields = { absenceId: AbsenceId, organizationId: OrganizationId, actorId: UserId, occurredOn: Schema.DateTimeUtc }

export const AbsenceDraftedEvent = Schema.TaggedStruct("AbsenceDraftedEvent", {
  ...absenceEventFields, creatorId: UserId, assigneeId: UserId, period: Period, // occurredOn becomes createdAt
})
export type AbsenceDraftedEvent = typeof AbsenceDraftedEvent.Type

export const AbsenceRescheduledEvent = Schema.TaggedStruct("AbsenceRescheduledEvent", {
  ...absenceEventFields, period: Period, previousPeriod: Period,
})
export type AbsenceRescheduledEvent = typeof AbsenceRescheduledEvent.Type

export const AbsenceReassignedEvent = Schema.TaggedStruct("AbsenceReassignedEvent", {
  ...absenceEventFields, assigneeId: UserId, previousAssigneeId: UserId,
})
export type AbsenceReassignedEvent = typeof AbsenceReassignedEvent.Type

export const AbsenceActivatedEvent = Schema.TaggedStruct("AbsenceActivatedEvent", { ...absenceEventFields })
export type AbsenceActivatedEvent = typeof AbsenceActivatedEvent.Type

export const AbsenceArchivedEvent = Schema.TaggedStruct("AbsenceArchivedEvent", { ...absenceEventFields })
export type AbsenceArchivedEvent = typeof AbsenceArchivedEvent.Type

// assigneeId and period: subscribers can still act on a gone absence
export const AbsenceDeletedEvent = Schema.TaggedStruct("AbsenceDeletedEvent", {
  ...absenceEventFields, assigneeId: UserId, period: Period,
})
export type AbsenceDeletedEvent = typeof AbsenceDeletedEvent.Type

export const AbsenceEvent = Schema.Union([
  AbsenceDraftedEvent, AbsenceRescheduledEvent, AbsenceReassignedEvent,
  AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDeletedEvent,
])
export type AbsenceEvent = typeof AbsenceEvent.Type
