import { Data } from "effect"
import type { UserId } from "../../shared/ids.ts"

// Capabilities, not a role. Every flag holds for the organization of the request.
export type AbsenceActor = {
  readonly userId: UserId
  readonly mayEditOthersAbsences: boolean        // reschedule, reassign, archive someone else's active absence
  readonly mayDeleteOthersAbsences: boolean      // delete someone else's active absence
  readonly mayAssignAnyone: boolean              // assign to any member, not only self or related users
  readonly mayReadOthersAbsences: boolean        // see absences the actor isn't involved in
  readonly relatedUserIds: ReadonlySet<UserId>   // loaded once per request
}

// A read-only principal builds only these.
export type AbsenceReader = Pick<AbsenceActor, "userId" | "mayReadOthersAbsences" | "relatedUserIds">

// The read rule as data. Views take a visibility, never an actor.
export type AbsenceVisibility = Data.TaggedEnum<{
  AllAbsences: {}                                                   // system reads: jobs, listeners
  OrganizationAbsences: { readonly userId: UserId }                 // all, except others' drafts
  InvolvedAbsences: { readonly userId: UserId; readonly relatedUserIds: ReadonlySet<UserId> }
                                                                    // created, assigned, or assigned to a related user; except others' drafts
}>
export const AbsenceVisibility = Data.taggedEnum<AbsenceVisibility>()

export const absenceVisibilityFromReader = (reader: AbsenceReader): AbsenceVisibility =>
  reader.mayReadOthersAbsences
    ? AbsenceVisibility.OrganizationAbsences({ userId: reader.userId })
    : AbsenceVisibility.InvolvedAbsences({ userId: reader.userId, relatedUserIds: reader.relatedUserIds })
