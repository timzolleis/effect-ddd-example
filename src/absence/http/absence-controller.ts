import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api.ts"
import { CurrentActor } from "../../shared/current-user.ts"
import { UserRelationships } from "../../shared/user-relationships.ts"
import { ActivateAbsenceService } from "../application/activate-absence-service.ts"
import { ArchiveAbsenceService } from "../application/archive-absence-service.ts"
import { CreateAbsenceService } from "../application/create-absence-service.ts"
import { DeleteAbsenceService } from "../application/delete-absence-service.ts"
import { ReassignAbsenceService } from "../application/reassign-absence-service.ts"
import { RescheduleAbsenceService } from "../application/reschedule-absence-service.ts"
import { absenceVisibilityFromReader } from "../domain/absence-actor.ts"
import { absenceActorFromPermissions } from "../infrastructure/absence-permissions.ts"
import { AbsenceViews } from "../view/absence-views.ts"
import { absenceHttpErrorFromAbsenceError } from "./absence-http-errors.ts"

export const AbsenceController = HttpApiBuilder.group(Api, "absences", Effect.fn(function* (handlers) {
  const createAbsenceService = yield* CreateAbsenceService
  const rescheduleAbsenceService = yield* RescheduleAbsenceService
  const reassignAbsenceService = yield* ReassignAbsenceService
  const activateAbsenceService = yield* ActivateAbsenceService
  const archiveAbsenceService = yield* ArchiveAbsenceService
  const deleteAbsenceService = yield* DeleteAbsenceService
  const absenceViews = yield* AbsenceViews
  const userRelationships = yield* UserRelationships

  // Once per request: the actor for commands, and the visibility for reads.
  const loadAbsenceActor = Effect.gen(function* () {
    const currentActor = yield* CurrentActor
    const relatedUserIds = yield* userRelationships.listRelatedUserIds({
      organizationId: currentActor.organizationId, userId: currentActor.userId,
    })
    const actor = absenceActorFromPermissions({ ...currentActor, relatedUserIds })
    return { organizationId: currentActor.organizationId, actor, visibility: absenceVisibilityFromReader(actor) }
  })

  return handlers.handleAll({
    createAbsence: ({ payload }) => Effect.gen(function* () {
      const { organizationId, actor, visibility } = yield* loadAbsenceActor
      const absenceId = yield* createAbsenceService.createAbsence({ organizationId, actor, ...payload })
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),

    rescheduleAbsence: ({ params, payload }) => Effect.gen(function* () {
      const { organizationId, actor, visibility } = yield* loadAbsenceActor
      yield* rescheduleAbsenceService.rescheduleAbsence({ organizationId, actor, absenceId: params.absenceId, ...payload })
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId: params.absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),

    reassignAbsence: ({ params, payload }) => Effect.gen(function* () {
      const { organizationId, actor, visibility } = yield* loadAbsenceActor
      yield* reassignAbsenceService.reassignAbsence({ organizationId, actor, absenceId: params.absenceId, assigneeId: payload.assigneeId })
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId: params.absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),

    activateAbsence: ({ params }) => Effect.gen(function* () {
      const { organizationId, actor, visibility } = yield* loadAbsenceActor
      yield* activateAbsenceService.activateAbsence({ organizationId, actor, absenceId: params.absenceId })
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId: params.absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),

    archiveAbsence: ({ params }) => Effect.gen(function* () {
      const { organizationId, actor, visibility } = yield* loadAbsenceActor
      yield* archiveAbsenceService.archiveAbsence({ organizationId, actor, absenceId: params.absenceId })
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId: params.absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),

    deleteAbsence: ({ params }) => Effect.gen(function* () {
      const { organizationId, actor } = yield* loadAbsenceActor
      yield* deleteAbsenceService.deleteAbsence({ organizationId, actor, absenceId: params.absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),

    getAbsenceById: ({ params }) => Effect.gen(function* () {
      const { organizationId, visibility } = yield* loadAbsenceActor
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId: params.absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),

    listAbsences: ({ query }) => Effect.gen(function* () {
      const { organizationId, visibility } = yield* loadAbsenceActor
      return yield* absenceViews.listAbsences({ organizationId, visibility, ...query })
    }),
  })
}))
