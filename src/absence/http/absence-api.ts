import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { AuthMiddleware } from "../../lib/auth-middleware.ts"
import { OrganizationMemberMiddleware, OrganizationPathParams } from "../../lib/organization-member-middleware.ts"
import { UserId } from "../../shared/ids.ts"
import { AbsenceId } from "../domain/absence-id.ts"
import { AbsenceView } from "../view/absence-views.ts"
import {
  AbsenceAlreadyActiveHttpError, AbsenceAlreadyArchivedHttpError, AbsenceAlreadyExistsHttpError,
  AbsenceChangedConcurrentlyHttpError, AbsenceEditWindowClosedHttpError, AbsenceNotFoundHttpError, AbsenceOngoingHttpError,
  AbsenceStillDraftHttpError, AssigneeNotInOrganizationHttpError, InvalidPeriodHttpError, NotAbsenceCreatorHttpError,
  NotAllowedToAssignAbsenceHttpError, NotAllowedToDeleteAbsenceHttpError, NotAllowedToEditAbsenceHttpError,
} from "./absence-http-errors.ts"

const AbsencePathParams = Schema.Struct({ ...OrganizationPathParams.fields, absenceId: AbsenceId })

// Errors in check order: not found → wrong state → actor → policy / value → concurrency.
export class AbsenceApiGroup extends HttpApiGroup.make("absences")
  .add(
    HttpApiEndpoint.post("createAbsence", "/absences", {
      params: OrganizationPathParams,
      payload: Schema.Struct({
        absenceId: Schema.optional(AbsenceId),
        assigneeId: UserId,
        from: Schema.DateTimeUtc,
        to: Schema.DateTimeUtc,
      }),
      success: AbsenceView.pipe(HttpApiSchema.status(201)),
      error: [
        AssigneeNotInOrganizationHttpError, NotAllowedToAssignAbsenceHttpError, InvalidPeriodHttpError, AbsenceAlreadyExistsHttpError,
        AbsenceNotFoundHttpError, // read-back, if the absence is deleted before it
      ],
    }),
    HttpApiEndpoint.put("rescheduleAbsence", "/absences/:absenceId/period", {
      params: AbsencePathParams,
      payload: Schema.Struct({ from: Schema.DateTimeUtc, to: Schema.DateTimeUtc }),
      success: AbsenceView,
      error: [
        AbsenceNotFoundHttpError, AbsenceAlreadyArchivedHttpError, NotAllowedToEditAbsenceHttpError,
        AbsenceEditWindowClosedHttpError, InvalidPeriodHttpError, AbsenceChangedConcurrentlyHttpError,
      ],
    }),
    HttpApiEndpoint.put("reassignAbsence", "/absences/:absenceId/assignee", {
      params: AbsencePathParams,
      payload: Schema.Struct({ assigneeId: UserId }),
      success: AbsenceView,
      error: [
        AbsenceNotFoundHttpError, AbsenceAlreadyArchivedHttpError, NotAllowedToEditAbsenceHttpError,
        AssigneeNotInOrganizationHttpError, NotAllowedToAssignAbsenceHttpError, AbsenceEditWindowClosedHttpError,
        AbsenceChangedConcurrentlyHttpError,
      ],
    }),
    HttpApiEndpoint.post("activateAbsence", "/absences/:absenceId/activate", {
      params: AbsencePathParams,
      success: AbsenceView,
      error: [
        AbsenceNotFoundHttpError, AbsenceAlreadyActiveHttpError, AbsenceAlreadyArchivedHttpError,
        NotAbsenceCreatorHttpError, AbsenceChangedConcurrentlyHttpError,
      ],
    }),
    HttpApiEndpoint.post("archiveAbsence", "/absences/:absenceId/archive", {
      params: AbsencePathParams,
      success: AbsenceView,
      error: [
        AbsenceNotFoundHttpError, AbsenceStillDraftHttpError, AbsenceAlreadyArchivedHttpError,
        NotAllowedToEditAbsenceHttpError, AbsenceOngoingHttpError, AbsenceChangedConcurrentlyHttpError,
      ],
    }),
    HttpApiEndpoint.delete("deleteAbsence", "/absences/:absenceId", {
      params: AbsencePathParams,
      success: HttpApiSchema.NoContent,
      error: [
        AbsenceNotFoundHttpError, AbsenceAlreadyArchivedHttpError, NotAllowedToDeleteAbsenceHttpError,
        AbsenceChangedConcurrentlyHttpError,
      ],
    }),
    HttpApiEndpoint.get("getAbsenceById", "/absences/:absenceId", {
      params: AbsencePathParams,
      success: AbsenceView,
      error: AbsenceNotFoundHttpError,
    }),
    HttpApiEndpoint.get("listAbsences", "/absences", {
      params: OrganizationPathParams,
      query: { assigneeId: Schema.optionalKey(UserId), creatorId: Schema.optionalKey(UserId) },
      success: Schema.Array(AbsenceView),
    }),
  )
  // prefix and middleware apply only to endpoints added before them
  .prefix("/organizations/:organizationId")
  .middleware(OrganizationMemberMiddleware)
  .middleware(AuthMiddleware)
{}
