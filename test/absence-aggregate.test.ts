import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { generateAbsenceId } from "../src/absence/domain/absence-id.ts"
import {
  Absence, AbsenceArchivedEvent, ActivateAbsenceCommand, ArchiveAbsenceCommand, ArchivedAbsence, DiscardedAbsence, DraftAbsenceCommand,
  ReassignAbsenceCommand, RescheduleAbsenceCommand, WithdrawAbsenceCommand,
} from "../src/absence/domain/absence.ts"
import { alice, at, bob, child, makeActiveAbsence, makeActor, makeDraftAbsence, organizationId } from "./support.ts"

const draftAbsenceOfAlice = makeDraftAbsence({ creatorId: alice })
const activeAbsenceOfAlice = makeActiveAbsence({ creatorId: alice })
const actorAlice = makeActor({ userId: alice })
const actorBob = makeActor({ userId: bob })
const withinEditWindow = at("2026-02-01T10:30:00Z")
const afterEditWindow = at("2026-02-01T11:30:00Z")
const afterPeriod = at("2026-03-02T00:00:00Z")
const newPeriod = { from: at("2026-04-01T00:00:00Z"), to: at("2026-04-03T00:00:00Z") }

describe("Absence aggregate: decide, then evolve", () => {
  it("drafts an absence from no state", () => {
    const absenceId = generateAbsenceId()
    const event = Result.getOrThrow(Absence.decide({
      command: DraftAbsenceCommand.make({
        absenceId, organizationId, actor: actorAlice, assigneeId: alice, assigneeIsOrganizationMember: true, ...newPeriod,
      }),
      now: withinEditWindow,
    }))
    expect(Absence.evolve({ event })).toEqual({
      _tag: "DraftAbsence", absenceId, organizationId, creatorId: alice, assigneeId: alice, period: newPeriod,
      createdAt: withinEditWindow, updatedAt: withinEditWindow,
    })
  })

  it("refuses to draft for an assignee outside the organization", () => {
    const decision = Absence.decide({
      command: DraftAbsenceCommand.make({
        absenceId: generateAbsenceId(), organizationId, actor: actorAlice, assigneeId: bob, assigneeIsOrganizationMember: false,
        ...newPeriod,
      }),
      now: withinEditWindow,
    })
    expect(Result.getFailure(decision)).toMatchObject({ value: { _tag: "AssigneeNotInOrganizationError", assigneeId: bob } })
  })

  it.each([draftAbsenceOfAlice, activeAbsenceOfAlice])("reschedules a $_tag, which keeps its state", (absence) => {
    const command = RescheduleAbsenceCommand.make({ actor: actorAlice, ...newPeriod })
    const event = Result.getOrThrow(Absence.decide({ absence, command, now: withinEditWindow }))
    expect(event).toMatchObject({ _tag: "AbsenceRescheduledEvent", period: newPeriod, previousPeriod: absence.period })
    expect(Absence.evolve({ absence, event })).toEqual({ ...absence, period: newPeriod, updatedAt: withinEditWindow })
  })

  it("refuses to reschedule after the first hour", () => {
    const command = RescheduleAbsenceCommand.make({ actor: actorAlice, ...newPeriod })
    expect(Result.getFailure(Absence.decide({ absence: activeAbsenceOfAlice, command, now: afterEditWindow })))
      .toMatchObject({ value: { _tag: "AbsenceEditWindowClosedError", absenceId: activeAbsenceOfAlice.absenceId } })
  })

  it.each([draftAbsenceOfAlice, activeAbsenceOfAlice])("reassigns a $_tag, which keeps its state", (absence) => {
    const actorRelatedToChild = makeActor({ userId: alice, relatedUserIds: new Set([child]) })
    const command = ReassignAbsenceCommand.make({ actor: actorRelatedToChild, assigneeId: child, assigneeIsOrganizationMember: true })
    const event = Result.getOrThrow(Absence.decide({ absence, command, now: withinEditWindow }))
    expect(event).toMatchObject({ _tag: "AbsenceReassignedEvent", assigneeId: child, previousAssigneeId: alice })
    expect(Absence.evolve({ absence, event })).toEqual({ ...absence, assigneeId: child, updatedAt: withinEditWindow })
  })

  it("refuses to reassign to someone the actor is not related to", () => {
    const command = ReassignAbsenceCommand.make({ actor: actorAlice, assigneeId: bob, assigneeIsOrganizationMember: true })
    expect(Result.getFailure(Absence.decide({ absence: draftAbsenceOfAlice, command, now: withinEditWindow })))
      .toMatchObject({ value: { _tag: "NotAllowedToAssignAbsenceError", actorId: alice, assigneeId: bob } })
  })

  it("activates a draft absence", () => {
    const event = Result.getOrThrow(Absence.decide({
      absence: draftAbsenceOfAlice, command: ActivateAbsenceCommand.make({ actor: actorAlice }), now: withinEditWindow,
    }))
    expect(Absence.evolve({ absence: draftAbsenceOfAlice, event }))
      .toEqual({ ...draftAbsenceOfAlice, _tag: "ActiveAbsence", activatedAt: withinEditWindow, updatedAt: withinEditWindow })
  })

  it("refuses to activate someone else's draft", () => {
    const decision = Absence.decide({ absence: draftAbsenceOfAlice, command: ActivateAbsenceCommand.make({ actor: actorBob }), now: withinEditWindow })
    expect(Result.getFailure(decision)).toMatchObject({ value: { _tag: "NotAbsenceCreatorError", actorId: bob } })
  })

  it("archives an active absence whose period has ended, and keeps its activatedAt", () => {
    const event = Result.getOrThrow(Absence.decide({
      absence: activeAbsenceOfAlice, command: ArchiveAbsenceCommand.make({ actor: actorAlice }), now: afterPeriod,
    }))
    const absenceAfterArchive = Absence.evolve({ absence: activeAbsenceOfAlice, event })
    expect(absenceAfterArchive).toMatchObject({
      _tag: "ArchivedAbsence", absenceId: activeAbsenceOfAlice.absenceId, period: activeAbsenceOfAlice.period,
      activatedAt: activeAbsenceOfAlice.activatedAt, archivedAt: afterPeriod, updatedAt: afterPeriod,
    })
  })

  it("refuses to archive while the period is ongoing", () => {
    const decision = Absence.decide({
      absence: activeAbsenceOfAlice, command: ArchiveAbsenceCommand.make({ actor: actorAlice }), now: at("2026-03-01T12:00:00Z"),
    })
    expect(Result.getFailure(decision)).toMatchObject({ value: { _tag: "AbsenceOngoingError", absenceId: activeAbsenceOfAlice.absenceId } })
  })

  it("withdraws a draft into a discarded absence, which never had an activatedAt", () => {
    const event = Result.getOrThrow(Absence.decide({
      absence: draftAbsenceOfAlice, command: WithdrawAbsenceCommand.make({ actor: actorAlice }), now: withinEditWindow,
    }))
    expect(event).toEqual({
      _tag: "AbsenceWithdrawnEvent", absenceId: draftAbsenceOfAlice.absenceId, organizationId, actorId: alice, occurredOn: withinEditWindow,
    })
    expect(Absence.evolve({ absence: draftAbsenceOfAlice, event }))
      .toEqual({ ...draftAbsenceOfAlice, _tag: "DiscardedAbsence", archivedAt: withinEditWindow, updatedAt: withinEditWindow })
  })

  it("withdraws an active absence into an archived one, and keeps its activatedAt", () => {
    const event = Result.getOrThrow(Absence.decide({
      absence: activeAbsenceOfAlice, command: WithdrawAbsenceCommand.make({ actor: actorAlice }), now: withinEditWindow,
    }))
    expect(Absence.evolve({ absence: activeAbsenceOfAlice, event }))
      .toEqual({ ...activeAbsenceOfAlice, _tag: "ArchivedAbsence", archivedAt: withinEditWindow, updatedAt: withinEditWindow })
  })

  it("refuses to withdraw someone else's active absence without the permission", () => {
    const decision = Absence.decide({ absence: activeAbsenceOfAlice, command: WithdrawAbsenceCommand.make({ actor: actorBob }), now: withinEditWindow })
    expect(Result.getFailure(decision)).toMatchObject({ value: { _tag: "NotAllowedToDeleteAbsenceError", actorId: bob } })
  })

  it("throws when an event reaches a state that has no evolve for it", () => {
    const event = AbsenceArchivedEvent.make({
      absenceId: draftAbsenceOfAlice.absenceId, organizationId, actorId: alice, occurredOn: afterPeriod,
    })
    expect(() => Absence.evolve({
      absence: draftAbsenceOfAlice,
      // @ts-expect-error a DraftAbsence has no evolve for AbsenceArchivedEvent
      event,
    })).toThrow("Absence: DraftAbsence has no evolve for AbsenceArchivedEvent")
  })
})

describe("Building the next state with .make", () => {
  it("drops a field the next state lacks", () => {
    const { _tag, ...activeAbsenceFields } = activeAbsenceOfAlice
    expect(DiscardedAbsence.make({ ...activeAbsenceFields, archivedAt: afterPeriod })).not.toHaveProperty("activatedAt")
  })
})

describe("Aggregate schemas", () => {
  it("exposes the schemas it was defined with", () => {
    expect(Absence.states.ArchivedAbsence).toBe(ArchivedAbsence)
    expect(Absence.commands.WithdrawAbsenceCommand).toBe(WithdrawAbsenceCommand)
    expect(Absence.events.AbsenceArchivedEvent).toBe(AbsenceArchivedEvent)
  })

  it("lists the commands each state accepts, from the from lists", () => {
    expect(Absence.accepts).toEqual({
      initial: ["DraftAbsenceCommand"],
      DraftAbsence: ["RescheduleAbsenceCommand", "ReassignAbsenceCommand", "ActivateAbsenceCommand", "WithdrawAbsenceCommand"],
      ActiveAbsence: ["RescheduleAbsenceCommand", "ReassignAbsenceCommand", "ArchiveAbsenceCommand", "WithdrawAbsenceCommand"],
      ArchivedAbsence: [],
      DiscardedAbsence: [],
    })
  })

  it("lists the states each command is accepted in, from the from lists", () => {
    expect(Absence.acceptedIn).toEqual({
      DraftAbsenceCommand: ["initial"],
      RescheduleAbsenceCommand: ["DraftAbsence", "ActiveAbsence"],
      ReassignAbsenceCommand: ["DraftAbsence", "ActiveAbsence"],
      ActivateAbsenceCommand: ["DraftAbsence"],
      ArchiveAbsenceCommand: ["ActiveAbsence"],
      WithdrawAbsenceCommand: ["DraftAbsence", "ActiveAbsence"],
    })
  })
})
