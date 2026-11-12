import { Data, Schema } from "effect"
import { UserId } from "../../shared/ids.ts"

// Capabilities, not a role. Every flag holds for the organization of the request.
export const AbsenceActor = Schema.Struct({
  userId: UserId,
  mayEditOthersAbsences: Schema.Boolean,          // reschedule, reassign, archive someone else's active absence
  mayDeleteOthersAbsences: Schema.Boolean,        // withdraw someone else's active absence
  mayAssignAnyone: Schema.Boolean,                // assign to any member, not only self or related users
  mayReadOthersAbsences: Schema.Boolean,          // see absences the actor isn't involved in
  relatedUserIds: Schema.ReadonlySet(UserId),     // loaded once per request
})
export type AbsenceActor = typeof AbsenceActor.Type

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
