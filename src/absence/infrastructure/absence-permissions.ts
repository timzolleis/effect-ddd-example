import { Schema } from "effect"
import type { Permissions } from "../../shared/current-user.ts"
import type { OrganizationId, UserId } from "../../shared/ids.ts"
import type { AbsenceActor } from "../domain/absence-actor.ts"

// The absence module owns its keys. This file is the only code that reads them.
export const AbsencePermission = Schema.Literals(["absences:read", "absences:update", "absences:delete"])
export type AbsencePermission = typeof AbsencePermission.Type

// The caller loads relatedUserIds once per request.
export const absenceActorFromPermissions = ({ userId, organizationId, permissions, relatedUserIds }: {
  readonly userId: UserId
  readonly organizationId: OrganizationId
  readonly permissions: Permissions
  readonly relatedUserIds: ReadonlySet<UserId>
}): AbsenceActor => {
  const hasAbsencePermission = (permission: AbsencePermission) => permissions.hasPermission(permission, organizationId)
  return {
    userId,
    relatedUserIds,
    mayEditOthersAbsences: hasAbsencePermission("absences:update"),
    mayDeleteOthersAbsences: hasAbsencePermission("absences:delete"),
    mayAssignAnyone: hasAbsencePermission("absences:update"),
    mayReadOthersAbsences: hasAbsencePermission("absences:read") || hasAbsencePermission("absences:update"),   // edit implies read
  }
}
