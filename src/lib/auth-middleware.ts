import { Effect, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import { CurrentUser } from "../shared/current-user.ts"

// Stand-in for the host's authentication: resolves the session into CurrentUser.
export class NotAuthenticatedHttpError extends Schema.TaggedError<NotAuthenticatedHttpError>()("NotAuthenticatedHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("Sign in to continue."))),
}, { httpApiStatus: 401 }) {}

export class AuthMiddleware extends HttpApiMiddleware.Service<AuthMiddleware, {
  provides: CurrentUser
}>()("AuthMiddleware", {
  security: { bearer: HttpApiSecurity.bearer },
  requiredForClient: true,
  error: NotAuthenticatedHttpError,
}) {}
