import { Context, Effect } from "effect"
import { AbsenceEvent } from "../absence/domain/absence-event.ts"
import type { Transaction } from "./transaction.ts"

export const DomainEvent = AbsenceEvent // Schema.Union([AbsenceEvent, …]) once another module has events
export type DomainEvent = typeof DomainEvent.Type

// Delivery belongs to the host (outbox, bus); this module only publishes.
export class DomainEvents extends Context.Service<DomainEvents, {
  publishDomainEvent(event: DomainEvent): Effect.Effect<void>
}>()("DomainEvents") {}

// Opt-in, for an event that must never be lost: the event becomes an outbox row in the write's transaction.
// The host's relay delivers the rows.
export class DomainEventOutbox extends Context.Service<DomainEventOutbox, {
  addDomainEvent(event: DomainEvent): Effect.Effect<void, never, Transaction>
}>()("DomainEventOutbox") {}
