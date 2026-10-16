import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import { CurrentActor, CurrentUser } from "../shared/current-user.ts"
import { OrganizationId } from "../shared/ids.ts"
import { OrganizationMembers } from "../shared/organization-members.ts"

export class NotOrganizationMemberHttpError extends Schema.TaggedError<NotOrganizationMemberHttpError>()("NotOrganizationMemberHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("You're not a member of this organization."))),
}, { httpApiStatus: 403 }) {}

// Shared by the middleware and every endpoint's params, so both decode the same key with the same schema.
export const OrganizationPathParams = Schema.Struct({ organizationId: OrganizationId })

export class OrganizationMemberMiddleware extends HttpApiMiddleware.Service<OrganizationMemberMiddleware, {
  requires: CurrentUser
  provides: CurrentActor
}>()("OrganizationMemberMiddleware", { error: NotOrganizationMemberHttpError }) {
  static layer = Layer.effect(OrganizationMemberMiddleware, Effect.gen(function* () {
    const organizationMembers = yield* OrganizationMembers
    return OrganizationMemberMiddleware.of(Effect.fnUntraced(function* (handler) {
      // The endpoint's params are decoded inside `handler`, so the middleware decodes the route params itself.
      const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPathParams).pipe(Effect.orDie)
      const currentUser = yield* CurrentUser
      if (!(yield* organizationMembers.isOrganizationMember({ organizationId, userId: currentUser.userId }))) {
        return yield* new NotOrganizationMemberHttpError()
      }
      return yield* handler.pipe(Effect.provideService(CurrentActor, { ...currentUser, organizationId }))
    }))
  }))
}
