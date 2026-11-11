import { Cause, DateTime, Effect, Layer, Schema } from "effect"
import { PrismaService } from "~prisma/effect"
import { DomainEvent, DomainEventOutbox } from "../shared/domain-events.ts"
import { Transaction, Transactions } from "../shared/transaction.ts"

// Every PrismaService call inside the effect joins the transaction: the generated client reads it from the context.
// Sandboxed: the generated $transaction rethrows Cause.squash, which turns a defect into a typed failure. The whole
// cause passes through instead; anything else it throws (the commit failed) dies.
export const PrismaTransactions = Layer.effect(Transactions, Effect.gen(function* () {
  const prisma = yield* PrismaService
  return Transactions.of({
    runInTransaction: (effect) =>
      prisma.$transaction(effect.pipe(Effect.provideService(Transaction, Transaction.of({})), Effect.sandbox)).pipe(
        Effect.catch((cause) => Cause.isCause(cause) ? Effect.failCause(cause) : Effect.die(cause)),
      ),
  })
}))

const encodeDomainEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(DomainEvent)))

export const PrismaDomainEventOutbox = Layer.effect(DomainEventOutbox, Effect.gen(function* () {
  const prisma = yield* PrismaService
  return DomainEventOutbox.of({
    addDomainEvent: Effect.fn("PrismaDomainEventOutbox.addDomainEvent")(function* (event: DomainEvent) {
      yield* Transaction // outside a transaction the row could commit without the write: doesn't compile
      const payload = yield* encodeDomainEvent(event).pipe(Effect.orDie)
      yield* prisma.outboxEvent.create({
        data: { eventTag: event._tag, payload, occurredOn: DateTime.toDateUtc(event.occurredOn) },
        select: { id: true },
      }).pipe(Effect.orDie)
    }),
  })
}))
