import { Schema } from "effect"
import { createPrefixedId, prefixedId } from "../../lib/prefixed-id.ts"

// Own file, not absence.ts: events need AbsenceId, and absence.ts imports the events.
export const AbsenceId = prefixedId("abs").pipe(Schema.brand("AbsenceId"))
export type AbsenceId = typeof AbsenceId.Type

// make checks the pattern, so a wrong prefix throws on the first call.
export const generateAbsenceId = (): AbsenceId => AbsenceId.make(createPrefixedId("abs"))
