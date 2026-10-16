import { HttpApi } from "effect/http-api"
import { AbsenceApiGroup } from "./absence/http/absence-api.ts"

// The host's root API; each module adds its group.
export class Api extends HttpApi.make("api").add(AbsenceApiGroup) {}
