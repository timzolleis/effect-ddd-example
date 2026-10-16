import { Context, Effect } from "effect"
import type { AbsenceEvent } from "../absence/domain/absence-event.ts"

export type DomainEvent = AbsenceEvent // | …other modules' events

// Delivery belongs to the host (outbox, bus); this module only publishes.
export class DomainEvents extends Context.Service<DomainEvents, {
  publishDomainEvent(event: DomainEvent): Effect.Effect<void>
}>()("DomainEvents") {}
