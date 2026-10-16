import { Context, Effect } from "effect"
import type { OrganizationId, UserId } from "./ids.ts"

export class UserRelationships extends Context.Service<UserRelationships, {
  // e.g. guardian of, class teacher of; never contains userId
  listRelatedUserIds(input: { readonly organizationId: OrganizationId; readonly userId: UserId }): Effect.Effect<ReadonlySet<UserId>>
}>()("UserRelationships") {}
