import { type DateTime, Result, Schema } from "effect"
import type {
  AbsenceEditWindowClosedError, AbsenceOngoingError, AssigneeNotInOrganizationError, InvalidPeriodError, NotAbsenceCreatorError,
  NotAllowedToAssignAbsenceError, NotAllowedToDeleteAbsenceError, NotAllowedToEditAbsenceError,
} from "../src/absence/domain/absence-error.ts"
import { AbsenceId } from "../src/absence/domain/absence-id.ts"
import {
  assigneeMustBeInOrganizationPolicy, cannotArchiveWhileOngoingPolicy, checkPolicies, onlyCreatorCanActivatePolicy, onlyCreatorOrPermittedCanDeletePolicy,
  onlyCreatorOrPermittedCanEditPolicy,
} from "../src/absence/domain/absence-policy.ts"
import {
  Absence, AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDraftedEvent, type AbsenceEvent, AbsenceReassignedEvent, AbsenceRescheduledEvent,
  AbsenceWithdrawnEvent, ActivateAbsenceCommand, ActiveAbsence, ArchiveAbsenceCommand, ArchivedAbsence, DiscardedAbsence, DraftAbsence,
  DraftAbsenceCommand, type EditableAbsence, ReassignAbsenceCommand, RescheduleAbsenceCommand, WithdrawAbsenceCommand,
} from "../src/absence/domain/absence.ts"
import { Aggregate } from "../src/lib/aggregate.ts"

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false
const expectTrue = <_Check extends true>() => undefined

type AbsenceState = Aggregate.State<typeof Absence>
type DraftAbsenceCommand = typeof DraftAbsenceCommand.Type
type RescheduleAbsenceCommand = typeof RescheduleAbsenceCommand.Type
type ReassignAbsenceCommand = typeof ReassignAbsenceCommand.Type
type ActivateAbsenceCommand = typeof ActivateAbsenceCommand.Type
type ArchiveAbsenceCommand = typeof ArchiveAbsenceCommand.Type
type WithdrawAbsenceCommand = typeof WithdrawAbsenceCommand.Type

declare const now: DateTime.Utc
declare const draftAbsence: DraftAbsence
declare const activeAbsence: ActiveAbsence
declare const archivedAbsence: ArchivedAbsence
declare const editableAbsence: EditableAbsence
declare const anyAbsence: AbsenceState
declare const draftAbsenceCommand: DraftAbsenceCommand
declare const activateAbsenceCommand: ActivateAbsenceCommand
declare const archiveAbsenceCommand: ArchiveAbsenceCommand
declare const withdrawAbsenceCommand: WithdrawAbsenceCommand
declare const rescheduleAbsenceCommand: RescheduleAbsenceCommand
declare const reassignAbsenceCommand: ReassignAbsenceCommand
declare const absenceDraftedEvent: AbsenceDraftedEvent
declare const absenceActivatedEvent: AbsenceActivatedEvent
declare const absenceArchivedEvent: AbsenceArchivedEvent
declare const absenceWithdrawnEvent: AbsenceWithdrawnEvent

// Inference from from: decide sees the union of the states in from, evolve sees each state's fields; no annotations.
const FromInference = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence, DiscardedAbsence },
  commands: { DraftAbsenceCommand, WithdrawAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: {
      from: ["start"],
      event: AbsenceDraftedEvent,
      decide: ({ command, now }) => {
        expectTrue<Equal<typeof command, DraftAbsenceCommand>>()
        expectTrue<Equal<typeof now, DateTime.Utc>>()
        return absenceDraftedEvent
      },
      evolve: {
        start: ({ event }) => {
          expectTrue<Equal<typeof event, AbsenceDraftedEvent>>()
          return draftAbsence
        },
      },
    },
    WithdrawAbsenceCommand: {
      from: [DraftAbsence, ActiveAbsence],
      event: AbsenceWithdrawnEvent,
      decide: ({ absence, command }) => Result.gen(function* () {
        expectTrue<Equal<typeof absence, DraftAbsence | ActiveAbsence>>()
        expectTrue<Equal<typeof command, WithdrawAbsenceCommand>>()
        yield* checkPolicies([onlyCreatorOrPermittedCanDeletePolicy], { absence, actor: command.actor })
        return absenceWithdrawnEvent
      }),
      evolve: {
        DraftAbsence: ({ absence, event }) => {
          expectTrue<Equal<typeof absence, Omit<DraftAbsence, "_tag">>>()
          expectTrue<Equal<typeof event, AbsenceWithdrawnEvent>>()
          // @ts-expect-error evolve gets the state's fields without its tag
          absence._tag
          return DiscardedAbsence.make({ ...absence, archivedAt: event.occurredOn })
        },
        ActiveAbsence: ({ absence, event }) => {
          expectTrue<Equal<typeof absence, Omit<ActiveAbsence, "_tag">>>()
          return ArchivedAbsence.make({ ...absence, archivedAt: event.occurredOn })
        },
      },
    },
    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: ({ absence }) => {
        expectTrue<Equal<typeof absence, DraftAbsence>>()
        return absenceActivatedEvent
      },
      evolve: { DraftAbsence: ({ absence, event }) => ActiveAbsence.make({ ...absence, activatedAt: event.occurredOn }) },
    },
  },
})
const fromDecision = FromInference.decide({ absence: editableAbsence, command: withdrawAbsenceCommand, now })
expectTrue<Equal<typeof fromDecision, Result.Result<AbsenceWithdrawnEvent, NotAllowedToDeleteAbsenceError>>>()
const activeAbsenceAfterFromWithdraw = FromInference.evolve({ absence: activeAbsence, event: absenceWithdrawnEvent })
expectTrue<Equal<typeof activeAbsenceAfterFromWithdraw, ArchivedAbsence>>()

// Order: the record's keys in any order give the same types, from last included.
const AnyKeyOrder = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { evolve: { start: () => draftAbsence }, decide: () => absenceDraftedEvent, event: AbsenceDraftedEvent, from: ["start"] },
    ActivateAbsenceCommand: {
      event: AbsenceActivatedEvent,
      evolve: {
        DraftAbsence: ({ absence, event }) => {
          expectTrue<Equal<typeof absence, Omit<DraftAbsence, "_tag">>>()
          return ActiveAbsence.make({ ...absence, activatedAt: event.occurredOn })
        },
      },
      decide: ({ absence, command }) => Result.gen(function* () {
        expectTrue<Equal<typeof absence, DraftAbsence>>()
        yield* checkPolicies([onlyCreatorCanActivatePolicy], { absence, actor: command.actor })
        return absenceActivatedEvent
      }),
      from: [DraftAbsence],
    },
  },
})
const anyKeyOrderDecision = AnyKeyOrder.decide({ absence: draftAbsence, command: activateAbsenceCommand, now })
expectTrue<Equal<typeof anyKeyOrderDecision, Result.Result<AbsenceActivatedEvent, NotAbsenceCreatorError>>>()
const activeAbsenceAfterAnyKeyOrder = AnyKeyOrder.evolve({ absence: draftAbsence, event: absenceActivatedEvent })
expectTrue<Equal<typeof activeAbsenceAfterAnyKeyOrder, ActiveAbsence>>()

// Rules run inline: a rule that does not accept the input written at the call is a compile error on that rule.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ArchiveAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ArchiveAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceArchivedEvent,
      decide: ({ absence, command, now }) => Result.gen(function* () {
        yield* checkPolicies([
          onlyCreatorOrPermittedCanEditPolicy,
          // @ts-expect-error cannotArchiveWhileOngoingPolicy takes an ActiveAbsence
          cannotArchiveWhileOngoingPolicy,
        ], { absence, actor: command.actor, now })
        yield* checkPolicies([
          // @ts-expect-error the input has no assigneeIsOrganizationMember
          assigneeMustBeInOrganizationPolicy,
        ], { assigneeId: absence.assigneeId })
        return absenceArchivedEvent
      }),
      evolve: { DraftAbsence: () => activeAbsence },
    },
  },
})

// A rule whose input is derived is one more line: here the assignee check runs on the creator.
const checkCreatorIsAssignable = (absence: ActiveAbsence) => checkPolicies(
  [onlyCreatorOrPermittedCanEditPolicy, cannotArchiveWhileOngoingPolicy, assigneeMustBeInOrganizationPolicy],
  { absence, actor: activateAbsenceCommand.actor, now, assigneeId: absence.creatorId, assigneeIsOrganizationMember: true },
)
expectTrue<Equal<ReturnType<typeof checkCreatorIsAssignable>, Result.Result<
  void, NotAllowedToEditAbsenceError | AbsenceOngoingError | AssigneeNotInOrganizationError
>>>()

// Strict decide: a wrong pair fails, a union fails unless every state in it accepts the command.
Absence.decide({ absence: activeAbsence, command: archiveAbsenceCommand, now })
Absence.decide({ absence: editableAbsence, command: withdrawAbsenceCommand, now })
Absence.decide({
  // @ts-expect-error an ActiveAbsence cannot be activated
  absence: activeAbsence,
  command: activateAbsenceCommand, now,
})
Absence.decide({
  // @ts-expect-error the union holds a state that cannot be archived
  absence: editableAbsence,
  command: archiveAbsenceCommand, now,
})
Absence.decide({
  // @ts-expect-error the union holds states that cannot be withdrawn
  absence: anyAbsence,
  command: withdrawAbsenceCommand, now,
})
Absence.decide({
  // @ts-expect-error an ArchivedAbsence cannot be withdrawn
  absence: archivedAbsence,
  command: withdrawAbsenceCommand, now,
})
// @ts-expect-error archive needs an absence
Absence.decide({ command: archiveAbsenceCommand, now })
Absence.decide({
  // @ts-expect-error draft starts the lifecycle, so it takes no absence
  absence: draftAbsence,
  command: draftAbsenceCommand, now,
})

// Per-command result type: the event of the record; the errors are exactly those of the rules decide runs plus its own.
const draftDecision = Absence.decide({ command: draftAbsenceCommand, now })
expectTrue<Equal<typeof draftDecision, Result.Result<
  AbsenceDraftedEvent, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError
>>>()
const rescheduleDecision = Absence.decide({ absence: draftAbsence, command: rescheduleAbsenceCommand, now })
expectTrue<Equal<typeof rescheduleDecision, Result.Result<
  AbsenceRescheduledEvent, NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError | InvalidPeriodError
>>>()
const activateDecision = Absence.decide({ absence: draftAbsence, command: activateAbsenceCommand, now })
expectTrue<Equal<typeof activateDecision, Result.Result<AbsenceActivatedEvent, NotAbsenceCreatorError>>>()
const archiveDecision = Absence.decide({ absence: activeAbsence, command: archiveAbsenceCommand, now })
expectTrue<Equal<typeof archiveDecision, Result.Result<AbsenceArchivedEvent, NotAllowedToEditAbsenceError | AbsenceOngoingError>>>()
const withdrawDecision = Absence.decide({ absence: editableAbsence, command: withdrawAbsenceCommand, now })
expectTrue<Equal<typeof withdrawDecision, Result.Result<AbsenceWithdrawnEvent, NotAllowedToDeleteAbsenceError>>>()
const reassignDecision = Absence.decide({ absence: editableAbsence, command: reassignAbsenceCommand, now })
expectTrue<Equal<typeof reassignDecision, Result.Result<
  AbsenceReassignedEvent,
  NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError
>>>()
const rescheduleDecisionOfEditable = Absence.decide({ absence: editableAbsence, command: rescheduleAbsenceCommand, now })
expectTrue<Equal<typeof rescheduleDecisionOfEditable, typeof rescheduleDecision>>()

const absenceAfterDraft = Absence.evolve({ event: absenceDraftedEvent })
expectTrue<Equal<typeof absenceAfterDraft, DraftAbsence>>()
const draftAbsenceAfterWithdraw = Absence.evolve({ absence: draftAbsence, event: absenceWithdrawnEvent })
expectTrue<Equal<typeof draftAbsenceAfterWithdraw, DiscardedAbsence>>()
const editableAbsenceAfterWithdraw = Absence.evolve({ absence: editableAbsence, event: absenceWithdrawnEvent })
expectTrue<Equal<typeof editableAbsenceAfterWithdraw, DiscardedAbsence | ArchivedAbsence>>()
const activeAbsenceAfterReschedule = Absence.evolve({ absence: activeAbsence, event: null! as AbsenceRescheduledEvent })
expectTrue<Equal<typeof activeAbsenceAfterReschedule, ActiveAbsence>>()
const editableAbsenceAfterReschedule = Absence.evolve({ absence: editableAbsence, event: null! as AbsenceRescheduledEvent })
expectTrue<Equal<typeof editableAbsenceAfterReschedule, DraftAbsence | ActiveAbsence>>()
Absence.evolve({
  // @ts-expect-error a DraftAbsence has no evolve for AbsenceArchivedEvent
  absence: draftAbsence,
  event: absenceArchivedEvent,
})

// A decide that runs no rule returns the bare event.
const WithoutRule = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand, ArchiveAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: { from: [DraftAbsence], event: AbsenceActivatedEvent, decide: () => absenceActivatedEvent, evolve: { DraftAbsence: () => activeAbsence } },
    ArchiveAbsenceCommand: {
      from: [ActiveAbsence],
      event: AbsenceArchivedEvent,
      decide: () => absenceArchivedEvent,
      evolve: { ActiveAbsence: ({ absence, event }) => ArchivedAbsence.make({ ...absence, archivedAt: event.occurredOn }) },
    },
  },
})
const decisionWithoutRule = WithoutRule.decide({ absence: activeAbsence, command: archiveAbsenceCommand, now })
expectTrue<Equal<typeof decisionWithoutRule, AbsenceArchivedEvent>>()

// The unions of an aggregate. One record per command: events come from the records, so there is no events list to keep in step.
expectTrue<Equal<AbsenceState, DraftAbsence | ActiveAbsence | ArchivedAbsence | DiscardedAbsence>>()
expectTrue<Equal<Aggregate.Command<typeof Absence>,
  | DraftAbsenceCommand | RescheduleAbsenceCommand | ReassignAbsenceCommand | ActivateAbsenceCommand | ArchiveAbsenceCommand | WithdrawAbsenceCommand
>>()
expectTrue<Equal<keyof typeof Absence.events, AbsenceEvent["_tag"]>>()
expectTrue<Equal<typeof Absence.events.AbsenceArchivedEvent, typeof AbsenceArchivedEvent>>()
expectTrue<Equal<AbsenceEvent, AbsenceDraftedEvent | AbsenceRescheduledEvent | AbsenceReassignedEvent | AbsenceActivatedEvent | AbsenceArchivedEvent | AbsenceWithdrawnEvent>>()

// What a state accepts, derived from the from lists.
expectTrue<Equal<Aggregate.Accepts<typeof Absence, "start">, "DraftAbsenceCommand">>()
expectTrue<Equal<Aggregate.Accepts<typeof Absence, "DraftAbsence">,
  "RescheduleAbsenceCommand" | "ReassignAbsenceCommand" | "ActivateAbsenceCommand" | "WithdrawAbsenceCommand">>()
expectTrue<Equal<Aggregate.Accepts<typeof Absence, "ActiveAbsence">,
  "RescheduleAbsenceCommand" | "ReassignAbsenceCommand" | "ArchiveAbsenceCommand" | "WithdrawAbsenceCommand">>()
expectTrue<Equal<Aggregate.Accepts<typeof Absence, "ArchivedAbsence">, never>>()

// Terminal states need no record; a state that no evolve returns is a compile error on states.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand, ArchiveAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: { from: [DraftAbsence], event: AbsenceActivatedEvent, decide: () => absenceActivatedEvent, evolve: { DraftAbsence: () => activeAbsence } },
    ArchiveAbsenceCommand: { from: [ActiveAbsence], event: AbsenceArchivedEvent, decide: () => absenceArchivedEvent, evolve: { ActiveAbsence: () => archivedAbsence } },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  // @ts-expect-error no evolve returns ArchivedAbsence
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: { from: [DraftAbsence], event: AbsenceActivatedEvent, decide: () => absenceActivatedEvent, evolve: { DraftAbsence: () => activeAbsence } },
  },
})

// Records: every command has one, no record for a command outside commands, one command per event.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand, ArchiveAbsenceCommand },
  // @ts-expect-error ArchiveAbsenceCommand has no record
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: { from: [DraftAbsence], event: AbsenceActivatedEvent, decide: () => absenceActivatedEvent, evolve: { DraftAbsence: () => activeAbsence } },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: { from: [DraftAbsence], event: AbsenceActivatedEvent, decide: () => absenceActivatedEvent, evolve: { DraftAbsence: () => activeAbsence } },
    // @ts-expect-error ArchiveAbsenceCommand is not in commands
    ArchiveAbsenceCommand: { from: [ActiveAbsence], event: AbsenceArchivedEvent, decide: () => absenceArchivedEvent, evolve: { ActiveAbsence: () => activeAbsence } },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ArchiveAbsenceCommand, WithdrawAbsenceCommand },
  // @ts-expect-error ArchiveAbsenceCommand and WithdrawAbsenceCommand decide the same event
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ArchiveAbsenceCommand: { from: [ActiveAbsence], event: AbsenceArchivedEvent, decide: () => absenceArchivedEvent, evolve: { ActiveAbsence: () => archivedAbsence } },
    WithdrawAbsenceCommand: { from: [DraftAbsence], event: AbsenceArchivedEvent, decide: () => absenceArchivedEvent, evolve: { DraftAbsence: () => activeAbsence } },
  },
})

// from: a schema outside states, and start beside a state, are errors on that entry.
const CancelledAbsence = Schema.TaggedStruct("CancelledAbsence", { absenceId: AbsenceId })
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      // @ts-expect-error CancelledAbsence is not in states
      from: [DraftAbsence, CancelledAbsence],
      event: AbsenceActivatedEvent,
      decide: () => absenceActivatedEvent,
      evolve: { DraftAbsence: () => activeAbsence, CancelledAbsence: () => activeAbsence },
    },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      // @ts-expect-error start takes no state, so it cannot share a command with DraftAbsence
      from: ["start", DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: () => absenceActivatedEvent,
      evolve: { start: () => activeAbsence, DraftAbsence: () => activeAbsence },
    },
  },
})

// evolve: exactly one handler per state in from; a missing one and an extra one are errors on that record, naming the state.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand, WithdrawAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: { from: [DraftAbsence], event: AbsenceActivatedEvent, decide: () => absenceActivatedEvent, evolve: { DraftAbsence: () => activeAbsence } },
    WithdrawAbsenceCommand: {
      from: [DraftAbsence, ActiveAbsence],
      event: AbsenceWithdrawnEvent,
      decide: () => absenceWithdrawnEvent,
      // @ts-expect-error Property 'ActiveAbsence' is missing
      evolve: { DraftAbsence: () => archivedAbsence },
    },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: () => absenceActivatedEvent,
      evolve: {
        DraftAbsence: () => activeAbsence,
        // @ts-expect-error ActiveAbsence is not in from
        ActiveAbsence: ({ absence, event }) => ArchivedAbsence.make({ ...absence, archivedAt: event.occurredOn }),
      },
    },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: () => absenceActivatedEvent,
      evolve: {
        DraftAbsence: () => activeAbsence,
        // @ts-expect-error ArchivedAbsence is not in states
        ArchivedAbsence: () => activeAbsence,
      },
    },
  },
})

// A stray key in a record fails.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: () => absenceActivatedEvent,
      evolve: { DraftAbsence: () => activeAbsence },
      // @ts-expect-error rules is not a key of a record
      rules: [onlyCreatorCanActivatePolicy],
    },
  },
})

// An error in one handler is reported on that handler.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand, ArchiveAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: ({ absence, command, now }) => AbsenceActivatedEvent.make({
        absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId,
        // @ts-expect-error occurredOn is a DateTime.Utc
        occurredOn: now.epochMilliseconds,
      }),
      evolve: {
        DraftAbsence: ({ absence, event }) => ActiveAbsence.make({
          ...absence, updatedAt: event.occurredOn,
          // @ts-expect-error activatedAt is a DateTime.Utc
          activatedAt: event.actorId,
        }),
      },
    },
    ArchiveAbsenceCommand: {
      from: [ActiveAbsence],
      event: AbsenceArchivedEvent,
      decide: () => absenceArchivedEvent,
      // @ts-expect-error an event is not a state
      evolve: { ActiveAbsence: () => absenceArchivedEvent },
    },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      // @ts-expect-error decide returns another event than the record names
      decide: () => absenceArchivedEvent,
      evolve: { DraftAbsence: () => activeAbsence },
    },
  },
})

// A broken definition keeps the calls of its other commands compiling: while make fails, TS drops what it inferred from
// handlers that take parameters, so their decide result is Result<event of the record, any> and their evolve result is any.
// Handlers without parameters keep their types.
const WithMissingEvolve = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, DiscardedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand, WithdrawAbsenceCommand },
  handlers: {
    DraftAbsenceCommand: { from: ["start"], event: AbsenceDraftedEvent, decide: () => absenceDraftedEvent, evolve: { start: () => draftAbsence } },
    ActivateAbsenceCommand: {
      from: [DraftAbsence],
      event: AbsenceActivatedEvent,
      decide: ({ absence, command }) => Result.gen(function* () {
        yield* checkPolicies([onlyCreatorCanActivatePolicy], { absence, actor: command.actor })
        return absenceActivatedEvent
      }),
      evolve: { DraftAbsence: ({ absence, event }) => ActiveAbsence.make({ ...absence, activatedAt: event.occurredOn }) },
    },
    WithdrawAbsenceCommand: {
      from: [DraftAbsence, ActiveAbsence],
      event: AbsenceWithdrawnEvent,
      decide: () => absenceWithdrawnEvent,
      // @ts-expect-error Property 'ActiveAbsence' is missing
      evolve: { DraftAbsence: ({ absence, event }) => DiscardedAbsence.make({ ...absence, archivedAt: event.occurredOn }) },
    },
  },
})
const activateDecisionOfBrokenDefinition = WithMissingEvolve.decide({ absence: draftAbsence, command: activateAbsenceCommand, now })
expectTrue<Equal<typeof activateDecisionOfBrokenDefinition, Result.Result<AbsenceActivatedEvent, any>>>()
const activeAbsenceOfBrokenDefinition = WithMissingEvolve.evolve({ absence: draftAbsence, event: Result.getOrThrow(activateDecisionOfBrokenDefinition) })
expectTrue<Equal<typeof activeAbsenceOfBrokenDefinition, any>>()
WithMissingEvolve.decide({
  // @ts-expect-error the from lists survive, so a wrong pair still fails
  absence: activeAbsence,
  command: activateAbsenceCommand, now,
})
const draftAbsenceOfBrokenDefinition = WithMissingEvolve.evolve({ event: absenceDraftedEvent })
expectTrue<Equal<typeof draftAbsenceOfBrokenDefinition, DraftAbsence>>()

// A field the next state lacks passes silently through a spread; written out, it fails.
declare const activeAbsenceFields: Omit<ActiveAbsence, "_tag">
DiscardedAbsence.make({ ...activeAbsenceFields, archivedAt: now })
DiscardedAbsence.make({
  ...activeAbsenceFields, archivedAt: now,
  // @ts-expect-error DiscardedAbsence has no activatedAt
  activatedAt: now,
})
