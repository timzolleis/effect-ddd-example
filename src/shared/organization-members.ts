import { Context, Effect } from "effect"
import type { OrganizationId, UserId } from "./ids.ts"

export class OrganizationMembers extends Context.Service<OrganizationMembers, {
  isOrganizationMember(input: { readonly organizationId: OrganizationId; readonly userId: UserId }): Effect.Effect<boolean>
}>()("OrganizationMembers") {}
