import { createId } from "@paralleldrive/cuid2"
import { Schema } from "effect"

// `<prefix>_` + cuid2 (24 chars, lowercase, starts with a letter).
// The caller brands it: Schema.brand needs a literal, so a generic brand parameter doesn't compile.
export const prefixedId = (prefix: string) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(new RegExp(`^${prefix}_[a-z][a-z0-9]{23}$`))))

export const createPrefixedId = (prefix: string): string => `${prefix}_${createId()}`
