import { describe, expect, it } from "@effect/vitest"
import { SchemaAST, type Schema } from "effect"
import { AbsenceVisibility, absenceVisibilityFromReader } from "../src/absence/domain/absence-actor.ts"
import * as AbsenceErrors from "../src/absence/domain/absence-error.ts"
import { absenceHttpErrorFromAbsenceError } from "../src/absence/http/absence-http-errors.ts"
import { absenceActorFromPermissions } from "../src/absence/infrastructure/absence-permissions.ts"
import { alice, at, makeActor, organizationId, otherOrganizationId, unknownAbsenceId } from "./support.ts"

describe("absenceActorFromPermissions", () => {
  const actorWith = (keys: ReadonlyArray<string>, scopedTo = organizationId) => absenceActorFromPermissions({
    userId: alice, organizationId, relatedUserIds: new Set(),
    permissions: { hasPermission: (key, inOrganization) => inOrganization === scopedTo && keys.includes(key) },
  })
  const flags = (keys: ReadonlyArray<string>, scopedTo = organizationId) => {
    const { mayEditOthersAbsences, mayDeleteOthersAbsences, mayAssignAnyone, mayReadOthersAbsences } = actorWith(keys, scopedTo)
    return { mayEditOthersAbsences, mayDeleteOthersAbsences, mayAssignAnyone, mayReadOthersAbsences }
  }
  it.each([
    { keys: [], expected: { mayEditOthersAbsences: false, mayDeleteOthersAbsences: false, mayAssignAnyone: false, mayReadOthersAbsences: false } },
    { keys: ["absences:read"], expected: { mayEditOthersAbsences: false, mayDeleteOthersAbsences: false, mayAssignAnyone: false, mayReadOthersAbsences: true } },
    { keys: ["absences:update"], expected: { mayEditOthersAbsences: true, mayDeleteOthersAbsences: false, mayAssignAnyone: true, mayReadOthersAbsences: true } },
    { keys: ["absences:delete"], expected: { mayEditOthersAbsences: false, mayDeleteOthersAbsences: true, mayAssignAnyone: false, mayReadOthersAbsences: false } },
  ])("$keys", ({ keys, expected }) => expect(flags(keys)).toEqual(expected))

  it("a permission in another organization grants nothing here", () =>
    expect(Object.values(flags(["absences:update", "absences:delete"], otherOrganizationId)).some(Boolean)).toBe(false))
})

describe("absenceVisibilityFromReader", () => {
  it("mayReadOthersAbsences → OrganizationAbsences, else InvolvedAbsences", () => {
    expect(AbsenceVisibility.$is("OrganizationAbsences")(absenceVisibilityFromReader(makeActor({ userId: alice, mayReadOthersAbsences: true })))).toBe(true)
    expect(AbsenceVisibility.$is("InvolvedAbsences")(absenceVisibilityFromReader(makeActor({ userId: alice })))).toBe(true)
  })
})

describe("absenceHttpErrorFromAbsenceError", () => {
  const absenceId = unknownAbsenceId
  const actorId = alice
  const now = at("2026-02-01T10:00:00Z")
  const period = { from: now, to: now }
  it.each([
    [new AbsenceErrors.AbsenceNotFoundError({ absenceId }), 404],
    [new AbsenceErrors.AbsenceStillDraftError({ absenceId }), 409],
    [new AbsenceErrors.AbsenceAlreadyActiveError({ absenceId }), 409],
    [new AbsenceErrors.AbsenceAlreadyArchivedError({ absenceId }), 409],
    [new AbsenceErrors.NotAbsenceCreatorError({ absenceId, actorId }), 403],
    [new AbsenceErrors.NotAllowedToEditAbsenceError({ absenceId, actorId, absenceState: "DraftAbsence" }), 403],
    [new AbsenceErrors.NotAllowedToDeleteAbsenceError({ absenceId, actorId, absenceState: "ActiveAbsence" }), 403],
    [new AbsenceErrors.AssigneeNotInOrganizationError({ assigneeId: actorId }), 422],
    [new AbsenceErrors.NotAllowedToAssignAbsenceError({ actorId, assigneeId: actorId }), 403],
    [new AbsenceErrors.AbsenceEditWindowClosedError({ absenceId, createdAt: now, editableUntil: now }), 409],
    [new AbsenceErrors.AbsenceOngoingError({ absenceId, period }), 409],
    [new AbsenceErrors.InvalidPeriodError(period), 422],
    [new AbsenceErrors.AbsenceChangedConcurrentlyError({ absenceId }), 409],
    [new AbsenceErrors.AbsenceAlreadyExistsError({ absenceId }), 409],
  ] as const)("%s → %i", (error, status) => {
    const httpError = absenceHttpErrorFromAbsenceError(error)
    expect(httpError._tag).toBe(error._tag.replace(/Error$/, "HttpError"))
    expect(SchemaAST.resolveAt<number>("httpApiStatus")((httpError.constructor as unknown as Schema.Top).ast)).toBe(status)
    expect(httpError.message.length).toBeGreaterThan(0)
  })
})
