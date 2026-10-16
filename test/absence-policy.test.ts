import { describe, expect, it } from "@effect/vitest"
import { DateTime, Result } from "effect"
import {
  absenceEditableUntil, cannotArchiveWhileOngoingPolicy, checkPolicies, createAbsencePolicies,
  editOnlyInFirstHourPolicy, onlyCreatorCanActivatePolicy, onlyCreatorOrPermittedCanDeletePolicy, onlyCreatorOrPermittedCanEditPolicy,
} from "../src/absence/domain/absence-policy.ts"
import { generateAbsenceId } from "../src/absence/domain/absence-id.ts"
import { reassignAbsence } from "../src/absence/domain/absence.ts"
import { createPeriod } from "../src/absence/domain/period.ts"
import { alice, at, bob, child, makeActiveAbsence, makeActor, makeDraftAbsence, organizationId } from "./support.ts"

const failureTag = (result: Result.Result<unknown, { readonly _tag: string }>) =>
  Result.isFailure(result) ? result.failure._tag : "ok"

describe("actor policies: own / others' draft / others' active × flag", () => {
  const draftOfAlice = makeDraftAbsence({ creatorId: alice })
  const activeOfAlice = makeActiveAbsence({ creatorId: alice })
  const cases = [
    { absence: draftOfAlice, actor: makeActor({ userId: alice }), edit: "ok", delete: "ok" },
    { absence: activeOfAlice, actor: makeActor({ userId: alice }), edit: "ok", delete: "ok" },
    { absence: draftOfAlice, actor: makeActor({ userId: bob }), edit: "NotAllowedToEditAbsenceError", delete: "NotAllowedToDeleteAbsenceError" },
    { absence: draftOfAlice, actor: makeActor({ userId: bob, mayEditOthersAbsences: true, mayDeleteOthersAbsences: true }),
      edit: "NotAllowedToEditAbsenceError", delete: "NotAllowedToDeleteAbsenceError" },
    { absence: activeOfAlice, actor: makeActor({ userId: bob }), edit: "NotAllowedToEditAbsenceError", delete: "NotAllowedToDeleteAbsenceError" },
    { absence: activeOfAlice, actor: makeActor({ userId: bob, mayEditOthersAbsences: true }), edit: "ok", delete: "NotAllowedToDeleteAbsenceError" },
    { absence: activeOfAlice, actor: makeActor({ userId: bob, mayDeleteOthersAbsences: true }), edit: "NotAllowedToEditAbsenceError", delete: "ok" },
  ]
  it.each(cases)("$absence._tag by $actor.userId → edit $edit, delete $delete", ({ absence, actor, ...expected }) => {
    expect(failureTag(onlyCreatorOrPermittedCanEditPolicy({ absence, actor }))).toBe(expected.edit)
    expect(failureTag(onlyCreatorOrPermittedCanDeletePolicy({ absence, actor }))).toBe(expected.delete)
  })

  it("only the creator activates", () => {
    expect(failureTag(onlyCreatorCanActivatePolicy({ absence: draftOfAlice, actor: makeActor({ userId: alice }) }))).toBe("ok")
    expect(failureTag(onlyCreatorCanActivatePolicy({ absence: draftOfAlice, actor: makeActor({ userId: bob, mayEditOthersAbsences: true }) })))
      .toBe("NotAbsenceCreatorError")
  })
})

describe("assignee policies: membership × self / related / unrelated × mayAssignAnyone", () => {
  const cases = [
    { assigneeId: alice, member: true, mayAssignAnyone: false, expected: "ok" },
    { assigneeId: child, member: true, mayAssignAnyone: false, expected: "ok" },
    { assigneeId: bob, member: true, mayAssignAnyone: false, expected: "NotAllowedToAssignAbsenceError" },
    { assigneeId: bob, member: true, mayAssignAnyone: true, expected: "ok" },
    { assigneeId: bob, member: false, mayAssignAnyone: true, expected: "AssigneeNotInOrganizationError" },
  ]
  it.each(cases)("$assigneeId, member $member, mayAssignAnyone $mayAssignAnyone → $expected", ({ assigneeId, member, mayAssignAnyone, expected }) => {
    const actor = makeActor({ userId: alice, mayAssignAnyone, relatedUserIds: new Set([child]) })
    const result = checkPolicies(createAbsencePolicies, {
      absenceId: generateAbsenceId(), organizationId, actor, assigneeId, assigneeIsOrganizationMember: member,
      from: at("2026-03-01T00:00:00Z"), to: at("2026-03-02T00:00:00Z"), now: at("2026-02-01T10:00:00Z"),
    })
    expect(failureTag(result)).toBe(expected)
  })
})

describe("time policies at the boundary", () => {
  it("edit window: open at exactly createdAt + 1h, closed 1 ms after", () => {
    const absence = makeDraftAbsence({ createdAt: at("2026-02-01T10:00:00Z") })
    const until = absenceEditableUntil(absence)
    expect(DateTime.formatIso(until)).toBe("2026-02-01T11:00:00.000Z")
    expect(failureTag(editOnlyInFirstHourPolicy({ absence, now: until }))).toBe("ok")
    expect(failureTag(editOnlyInFirstHourPolicy({ absence, now: DateTime.add(until, { milliseconds: 1 }) })))
      .toBe("AbsenceEditWindowClosedError")
  })

  it("ongoing: from <= now < to", () => {
    const absence = makeActiveAbsence()
    const archiveAt = (now: DateTime.Utc) => failureTag(cannotArchiveWhileOngoingPolicy({ absence, actor: makeActor({ userId: alice }), now }))
    expect(archiveAt(DateTime.subtract(absence.period.from, { milliseconds: 1 }))).toBe("ok")
    expect(archiveAt(absence.period.from)).toBe("AbsenceOngoingError")
    expect(archiveAt(DateTime.subtract(absence.period.to, { milliseconds: 1 }))).toBe("AbsenceOngoingError")
    expect(archiveAt(absence.period.to)).toBe("ok")
  })

  it("createPeriod: from < to", () => {
    expect(failureTag(createPeriod({ from: at("2026-03-01T00:00:00Z"), to: at("2026-03-01T00:00:00Z") }))).toBe("InvalidPeriodError")
  })
})

describe("list order decides which rejection is reported", () => {
  it("reassign: an actor who may not edit gets NotAllowedToEdit, not the assignee errors", () => {
    const result = reassignAbsence({
      absence: makeDraftAbsence({ creatorId: alice }), actor: makeActor({ userId: bob }),
      assigneeId: child, assigneeIsOrganizationMember: false, now: at("2026-02-01T10:00:00Z"),
    })
    expect(failureTag(result)).toBe("NotAllowedToEditAbsenceError")
  })
})
