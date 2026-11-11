import { Context, Effect } from "effect"

// Proof that an effect runs inside a database transaction. Only runInTransaction provides it.
export class Transaction extends Context.Service<Transaction, {}>()("Transaction") {}

// Owned by the host: it opens the transaction its adapters share.
export class Transactions extends Context.Service<Transactions, {
  // Commits when the effect succeeds, rolls back when it fails.
  runInTransaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Transaction>>
}>()("Transactions") {}
