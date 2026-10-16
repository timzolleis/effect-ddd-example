import { DateTime } from "effect"

// null stays null; the return type follows the input.
export const dateTimeUtcFromDate = <D extends Date | null>(date: D): D extends Date ? DateTime.Utc : null =>
  (date === null ? null : DateTime.fromDateUnsafe(date)) as D extends Date ? DateTime.Utc : null
