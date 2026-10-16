import { DateTime, Result, Schema } from "effect"
import { InvalidPeriodError } from "./absence-error.ts"

export const Period = Schema.Struct({ from: Schema.DateTimeUtc, to: Schema.DateTimeUtc })
export type Period = typeof Period.Type

export const createPeriod = ({ from, to }: { readonly from: DateTime.Utc; readonly to: DateTime.Utc }): Result.Result<Period, InvalidPeriodError> =>
  DateTime.isLessThan(from, to) ? Result.succeed({ from, to }) : Result.fail(new InvalidPeriodError({ from, to }))

// from <= now < to. Not DateTime.between: it includes both ends.
export const isPeriodOngoingAt = ({ period, now }: { readonly period: Period; readonly now: DateTime.Utc }): boolean =>
  DateTime.isGreaterThanOrEqualTo(now, period.from) && DateTime.isLessThan(now, period.to)
