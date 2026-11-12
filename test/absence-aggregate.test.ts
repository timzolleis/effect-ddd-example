import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { AbsenceActor } from "../src/absence/domain/absence-actor.ts"
import {
  Absence, ActivateAbsenceCommand, ArchiveAbsenceCommand, DraftAbsenceCommand, ReassignAbsenceCommand,
  RescheduleAbsenceCommand, WithdrawAbsenceCommand,
} from "../src/absence/domain/absence-aggregate.ts"
import { AbsenceArchivedEvent, AbsenceReassignedEvent } from "../src/absence/domain/absence-event.ts"
import { AbsenceId, generateAbsenceId } from "../src/absence/domain/absence-id.ts"
import { assigneeMustBeInOrganizationPolicy, checkPolicies, withdrawAbsencePolicies } from "../src/absence/domain/absence-policy.ts"
import { ActiveAbsence, ArchivedAbsence, DraftAbsence } from "../src/absence/domain/absence.ts"
import { Aggregate } from "../src/lib/aggregate.ts"
import { UserId } from "../src/shared/ids.ts"
import {
  AbsenceDeletedEvent, alice, at, bob, child, DeleteAbsenceCommand, makeActiveAbsence, makeActor, makeArchivedAbsence, makeDraftAbsence,
  organizationId,
} from "./support.ts"

const draftAbsenceOfAlice = makeDraftAbsence({ creatorId: alice })
const activeAbsenceOfAlice = makeActiveAbsence({ creatorId: alice })
const archivedAbsenceOfAlice = makeArchivedAbsence({ creatorId: alice })
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
      // @ts-expect-error a DraftAbsence has no evolve for AbsenceArchivedEvent
      absence: draftAbsenceOfAlice,
      event,
    })).toThrow("Absence: block DraftAbsence has no evolve for AbsenceArchivedEvent")
  })
})

const AbsenceWithEnds = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DeleteAbsenceCommand },
  events: { AbsenceDeletedEvent },
  ends: { AbsenceDeletedEvent },
  handlers: {
    start: {},
    DraftAbsence: {},
    ActiveAbsence: {
      decide: {
        DeleteAbsenceCommand: ({ absence, command, now }) => Result.gen(function* () {
          yield* checkPolicies(withdrawAbsencePolicies, { absence, ...command, now })
          return AbsenceDeletedEvent.make({
            absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId,
            occurredOn: now, assigneeId: absence.assigneeId, period: absence.period,
          })
        }),
      },
    },
  },
})

describe("Aggregate schemas", () => {
  it("exposes the schemas it was defined with", () => {
    expect(Absence.states.ArchivedAbsence).toBe(ArchivedAbsence)
    expect(Absence.commands.WithdrawAbsenceCommand).toBe(WithdrawAbsenceCommand)
    expect(Absence.events.AbsenceArchivedEvent).toBe(AbsenceArchivedEvent)
  })
})

describe("Aggregate ends", () => {
  it("decides a terminal event, and throws when it is evolved", () => {
    const absence = activeAbsenceOfAlice
    const event = Result.getOrThrow(AbsenceWithEnds.decide({
      absence, command: DeleteAbsenceCommand.make({ actor: actorAlice }), now: withinEditWindow,
    }))
    expect(event).toMatchObject({ _tag: "AbsenceDeletedEvent", absenceId: absence.absenceId, period: absence.period })
    // @ts-expect-error no state exists after AbsenceDeletedEvent
    expect(() => AbsenceWithEnds.evolve({ absence, event })).toThrow("Absence: block ActiveAbsence has no evolve for AbsenceDeletedEvent")
  })
})

const ForceReassignAbsenceCommand = Schema.TaggedStruct("ForceReassignAbsenceCommand", {
  actor: AbsenceActor, assigneeId: UserId, assigneeIsOrganizationMember: Schema.Boolean,
})

const AbsenceWithAnyBlock = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { ReassignAbsenceCommand, ForceReassignAbsenceCommand },
  events: { AbsenceReassignedEvent },
  handlers: {
    start: {},
    any: {
      decide: {
        ForceReassignAbsenceCommand: ({ absence, command, now }) =>
          Result.gen(function* () {
            yield* assigneeMustBeInOrganizationPolicy(command)
            return AbsenceReassignedEvent.make({
              absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId,
              occurredOn: now, assigneeId: command.assigneeId, previousAssigneeId: absence.assigneeId,
            })
          }),
      },
      evolve: {
        AbsenceReassignedEvent: ({ absence, event }) => ({ ...absence, assigneeId: event.assigneeId }),
      },
    },
    DraftAbsence: {},
    ActiveAbsence: {
      decide: {
        ReassignAbsenceCommand: ({ absence, command, now }) =>
          AbsenceReassignedEvent.make({
            absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId,
            occurredOn: now, assigneeId: command.assigneeId, previousAssigneeId: absence.assigneeId,
          }),
      },
    },
    ArchivedAbsence: {},
  },
})

describe("Aggregate any block", () => {
  const now = at("2026-02-01T10:30:00Z")
  const actor = makeActor({ userId: alice })
  const archivedAbsence = archivedAbsenceOfAlice

  it("decides in any when the state's block has no decide for the command, and evolves in any keeping the state", () => {
    const event = Result.getOrThrow(AbsenceWithAnyBlock.decide({
      absence: archivedAbsence,
      command: ForceReassignAbsenceCommand.make({ actor, assigneeId: child, assigneeIsOrganizationMember: true }),
      now,
    }))
    expect(event).toMatchObject({ _tag: "AbsenceReassignedEvent", assigneeId: child, previousAssigneeId: alice })
    expect(AbsenceWithAnyBlock.evolve({ absence: archivedAbsence, event })).toEqual({ ...archivedAbsence, assigneeId: child })
  })

  it("refuses through the any handler's rule", () => {
    const decision = AbsenceWithAnyBlock.decide({
      absence: makeDraftAbsence({ creatorId: alice }),
      command: ForceReassignAbsenceCommand.make({ actor, assigneeId: bob, assigneeIsOrganizationMember: false }),
      now,
    })
    expect(Result.getFailure(decision)).toMatchObject({ value: { _tag: "AssigneeNotInOrganizationError", assigneeId: bob } })
  })

  it("decides in the state's block and evolves in any", () => {
    const absence = makeActiveAbsence({ creatorId: alice })
    const event = AbsenceWithAnyBlock.decide({ absence, command: ReassignAbsenceCommand.make({ actor, assigneeId: child, assigneeIsOrganizationMember: true }), now })
    expect(AbsenceWithAnyBlock.evolve({ absence, event })).toEqual({ ...absence, assigneeId: child })
  })

  it("throws when a command of any arrives without a state: start never falls back to any", () => {
    const command = ForceReassignAbsenceCommand.make({ actor, assigneeId: child, assigneeIsOrganizationMember: true })
    // @ts-expect-error any is not start: the command needs an absence
    expect(() => AbsenceWithAnyBlock.decide({ command, now }))
      .toThrow("Absence: block start has no decide for ForceReassignAbsenceCommand")
  })
})
