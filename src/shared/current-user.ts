import { Context } from "effect"
import type { OrganizationId, UserId } from "./ids.ts"

// The host's permission system: may this user use this permission key in this organization?
export type Permissions = {
  hasPermission(permission: string, organizationId: OrganizationId): boolean
}

// Provided by the host's AuthMiddleware from the session.
export class CurrentUser extends Context.Service<CurrentUser, {
  readonly userId: UserId
  readonly permissions: Permissions
}>()("CurrentUser") {}

// Provided by OrganizationMemberMiddleware: the current user, checked as a member of the route's organization.
export class CurrentActor extends Context.Service<CurrentActor, {
  readonly userId: UserId
  readonly organizationId: OrganizationId
  readonly permissions: Permissions
}>()("CurrentActor") {}
