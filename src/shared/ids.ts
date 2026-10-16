import { Schema } from "effect"

// Owned by the organization and user modules; the absence module only references them.
export const OrganizationId = Schema.String.pipe(Schema.brand("OrganizationId"))
export type OrganizationId = typeof OrganizationId.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
