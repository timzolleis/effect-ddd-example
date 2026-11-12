import { type DateTime, Result, Schema } from "effect"
import { AbsenceActor } from "../src/absence/domain/absence-actor.ts"
import {
  Absence, ActivateAbsenceCommand, ArchiveAbsenceCommand, DraftAbsenceCommand,
  type ReassignAbsenceCommand as AbsenceReassignCommand, RescheduleAbsenceCommand, WithdrawAbsenceCommand,
} from "../src/absence/domain/absence-aggregate.ts"
import type {
  AbsenceEditWindowClosedError, AbsenceOngoingError, AssigneeNotInOrganizationError, InvalidPeriodError, NotAbsenceCreatorError,
  NotAllowedToAssignAbsenceError, NotAllowedToDeleteAbsenceError, NotAllowedToEditAbsenceError,
} from "../src/absence/domain/absence-error.ts"
import {
  AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDraftedEvent, AbsenceReassignedEvent,
  AbsenceRescheduledEvent, AbsenceWithdrawnEvent,
} from "../src/absence/domain/absence-event.ts"
import { AbsenceId } from "../src/absence/domain/absence-id.ts"
import { assigneeMustBeInOrganizationPolicy, checkPolicies, withdrawAbsencePolicies } from "../src/absence/domain/absence-policy.ts"
import {
  type Absence as AbsenceState, ActiveAbsence, ArchivedAbsence, DiscardedAbsence, DraftAbsence, type reassignAbsence, type rescheduleAbsence,
  type withdrawAbsence,
} from "../src/absence/domain/absence.ts"
import { Aggregate } from "../src/lib/aggregate.ts"
import { UserId } from "../src/shared/ids.ts"
import { AbsenceDeletedEvent, DeleteAbsenceCommand } from "./support.ts"

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false
const expectTrue = <_Check extends true>() => undefined

declare const now: DateTime.Utc
declare const draftAbsence: DraftAbsence
declare const activeAbsence: ActiveAbsence
declare const editableAbsence: DraftAbsence | ActiveAbsence
declare const anyAbsence: AbsenceState
declare const draftAbsenceCommand: DraftAbsenceCommand
declare const activateAbsenceCommand: ActivateAbsenceCommand
declare const archiveAbsenceCommand: ArchiveAbsenceCommand
declare const absenceDraftedEvent: AbsenceDraftedEvent
declare const absenceActivatedEvent: AbsenceActivatedEvent
declare const absenceArchivedEvent: AbsenceArchivedEvent

// Claim 1: handler arguments are typed from the sibling states / commands / events, without annotations.
export const SiblingInference = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand },
  events: { AbsenceDraftedEvent, AbsenceActivatedEvent },
  handlers: {
    start: {
      decide: {
        DraftAbsenceCommand: (input) => {
          expectTrue<Equal<typeof input, { readonly command: DraftAbsenceCommand; readonly now: DateTime.Utc }>>()
          return absenceDraftedEvent
        },
      },
      evolve: {
        AbsenceDraftedEvent: (input) => {
          expectTrue<Equal<typeof input, { readonly event: AbsenceDraftedEvent }>>()
          return draftAbsence
        },
      },
    },
    DraftAbsence: {
      decide: {
        ActivateAbsenceCommand: ({ absence, command, now }) => {
          expectTrue<Equal<typeof absence, DraftAbsence>>()
          expectTrue<Equal<typeof command, ActivateAbsenceCommand>>()
          expectTrue<Equal<typeof now, DateTime.Utc>>()
          return absenceActivatedEvent
        },
      },
      evolve: {
        AbsenceActivatedEvent: ({ absence, event }) => {
          expectTrue<Equal<typeof absence, DraftAbsence>>()
          expectTrue<Equal<typeof event, AbsenceActivatedEvent>>()
          return activeAbsence
        },
      },
    },
    ActiveAbsence: {},
  },
})

// Claim 2: decide takes only the states whose block decides the command.
Absence.decide({ absence: activeAbsence, command: archiveAbsenceCommand, now })
Absence.decide({ absence: draftAbsence, command: activateAbsenceCommand, now })
Absence.decide({ command: draftAbsenceCommand, now })
Absence.decide({
  // @ts-expect-error an ActiveAbsence cannot be activated
  absence: activeAbsence,
  command: activateAbsenceCommand, now,
})
Absence.decide({
  // @ts-expect-error the union holds states that cannot be archived
  absence: anyAbsence,
  command: archiveAbsenceCommand, now,
})
Absence.decide({
  // @ts-expect-error the union holds a state that cannot be archived
  absence: editableAbsence,
  command: archiveAbsenceCommand, now,
})
// @ts-expect-error archive needs an absence
Absence.decide({ command: archiveAbsenceCommand, now })
Absence.decide({
  // @ts-expect-error draft starts the lifecycle, so it takes no absence
  absence: draftAbsence,
  command: draftAbsenceCommand, now,
})
Absence.evolve({
  // @ts-expect-error a DraftAbsence has no evolve for AbsenceArchivedEvent
  absence: draftAbsence,
  event: absenceArchivedEvent,
})

// Claim 3: the result is the handler's own event and errors.
const archiveDecision = Absence.decide({ absence: activeAbsence, command: archiveAbsenceCommand, now })
expectTrue<Equal<typeof archiveDecision, Result.Result<AbsenceArchivedEvent, NotAllowedToEditAbsenceError | AbsenceOngoingError>>>()
const activateDecision = Absence.decide({ absence: draftAbsence, command: activateAbsenceCommand, now })
expectTrue<Equal<typeof activateDecision, Result.Result<AbsenceActivatedEvent, NotAbsenceCreatorError>>>()
const draftDecision = Absence.decide({ command: draftAbsenceCommand, now })
expectTrue<Equal<typeof draftDecision, Result.Result<
  AbsenceDraftedEvent, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError
>>>()

const absenceAfterDraft = Absence.evolve({ event: absenceDraftedEvent })
expectTrue<Equal<typeof absenceAfterDraft, DraftAbsence>>()
const absenceAfterActivate = Absence.evolve({ absence: draftAbsence, event: absenceActivatedEvent })
expectTrue<Equal<typeof absenceAfterActivate, ActiveAbsence>>()
const absenceAfterArchive = Absence.evolve({ absence: activeAbsence, event: absenceArchivedEvent })
expectTrue<Equal<typeof absenceAfterArchive, ArchivedAbsence>>()

// Claim 3: a handler without a rule returns the bare event, and so does decide.
const WithoutRule = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { ActiveAbsence, ArchivedAbsence },
  commands: { ArchiveAbsenceCommand },
  events: { AbsenceArchivedEvent },
  handlers: {
    start: {},
    ActiveAbsence: {
      decide: {
        ArchiveAbsenceCommand: ({ absence, command, now }) =>
          AbsenceArchivedEvent.make({
            absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId,
            occurredOn: now,
          }),
      },
      evolve: {
        AbsenceArchivedEvent: ({ absence, event }) =>
          ArchivedAbsence.make({ ...absence, _tag: "ArchivedAbsence", archivedAt: event.occurredOn }),
      },
    },
    ArchivedAbsence: {},
  },
})
const decisionWithoutRule = WithoutRule.decide({ absence: activeAbsence, command: archiveAbsenceCommand, now })
expectTrue<Equal<typeof decisionWithoutRule, AbsenceArchivedEvent>>()

// Claim 4: an event that no block evolves is reported on every evolve handler.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent, AbsenceArchivedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: { ActivateAbsenceCommand: () => absenceActivatedEvent },
      evolve: {
        // @ts-expect-error no block evolves AbsenceArchivedEvent
        AbsenceActivatedEvent: () => activeAbsence,
      },
    },
    ActiveAbsence: {},
  },
})

// Claim 4: a command that no block decides is reported on every decide handler.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand, ArchiveAbsenceCommand },
  events: { AbsenceActivatedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: {
        // @ts-expect-error no block decides ArchiveAbsenceCommand
        ActivateAbsenceCommand: () => absenceActivatedEvent,
      },
      evolve: { AbsenceActivatedEvent: () => activeAbsence },
    },
    ActiveAbsence: {},
  },
})

// Claim 4: a key that is no command, no event, no state, and no handler kind.
const Reactivated = Schema.TaggedStruct("AbsenceReactivatedEvent", {})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: {
        ActivateAbsenceCommand: () => absenceActivatedEvent,
        // @ts-expect-error ArchiveAbsenceCommand is not in commands
        ArchiveAbsenceCommand: () => absenceActivatedEvent,
      },
      evolve: {
        AbsenceActivatedEvent: () => activeAbsence,
        // @ts-expect-error AbsenceReactivatedEvent is not in events
        AbsenceReactivatedEvent: () => activeAbsence,
      },
      // @ts-expect-error a block holds only decide and evolve
      react: {},
    },
    ActiveAbsence: {},
    // @ts-expect-error ArchivedAbsence is not in states
    ArchivedAbsence: {},
  },
})

// Claim 4: a state without a block.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent },
  // @ts-expect-error ActiveAbsence has no block
  handlers: {
    start: {},
    DraftAbsence: {
      decide: { ActivateAbsenceCommand: () => absenceActivatedEvent },
      evolve: { AbsenceActivatedEvent: () => activeAbsence },
    },
  },
})

// Claim 4: a handler that returns something else than an event of the aggregate, or a state of it.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: {
        // @ts-expect-error AbsenceReactivatedEvent is not in events
        ActivateAbsenceCommand: () => Reactivated.make({}),
      },
      evolve: {
        // @ts-expect-error an event is not a state
        AbsenceActivatedEvent: () => absenceActivatedEvent,
      },
    },
    ActiveAbsence: {},
  },
})

// Claim 5: a wrong field in an event is reported on its own line.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: {
        ActivateAbsenceCommand: ({ absence, command, now }) =>
          AbsenceActivatedEvent.make({
            absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId,
            // @ts-expect-error occurredOn is a DateTime.Utc
            occurredOn: now.epochMilliseconds,
          }),
      },
      evolve: {
        AbsenceActivatedEvent: ({ absence, event }) =>
          ActiveAbsence.make({
            ...absence, _tag: "ActiveAbsence",
            // @ts-expect-error activatedAt is a DateTime.Utc
            activatedAt: event.actorId,
          }),
      },
    },
    ActiveAbsence: {},
  },
})

// The any block. ReassignAbsenceCommand is the repo's reassign (draft and active only); its event changes no state tag.
// ForceReassignAbsenceCommand is test-only: the repo has no command that every state accepts.
const ReassignAbsenceCommand = Schema.TaggedStruct("ReassignAbsenceCommand", { actor: AbsenceActor, assigneeId: UserId })
type ReassignAbsenceCommand = typeof ReassignAbsenceCommand.Type
const ForceReassignAbsenceCommand = Schema.TaggedStruct("ForceReassignAbsenceCommand", {
  actor: AbsenceActor, assigneeId: UserId, assigneeIsOrganizationMember: Schema.Boolean,
})
type ForceReassignAbsenceCommand = typeof ForceReassignAbsenceCommand.Type

declare const archivedAbsence: ArchivedAbsence
declare const reassignAbsenceCommand: ReassignAbsenceCommand
declare const forceReassignAbsenceCommand: ForceReassignAbsenceCommand
declare const absenceReassignedEvent: AbsenceReassignedEvent

// any: handlers get the union of all states; a command decided only in any and an event evolved only in any are handled.
const WithAny = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence, DiscardedAbsence },
  commands: { ReassignAbsenceCommand, ForceReassignAbsenceCommand },
  events: { AbsenceReassignedEvent },
  handlers: {
    start: {},
    any: {
      decide: {
        ForceReassignAbsenceCommand: ({ absence, command, now }) =>
          Result.gen(function* () {
            expectTrue<Equal<typeof absence, AbsenceState>>()
            expectTrue<Equal<typeof command, ForceReassignAbsenceCommand>>()
            expectTrue<Equal<typeof now, DateTime.Utc>>()
            yield* assigneeMustBeInOrganizationPolicy(command)
            return AbsenceReassignedEvent.make({
              absenceId: absence.absenceId, organizationId: absence.organizationId, actorId: command.actor.userId,
              occurredOn: now, assigneeId: command.assigneeId, previousAssigneeId: absence.assigneeId,
            })
          }),
      },
      evolve: {
        AbsenceReassignedEvent: ({ absence, event }) => {
          expectTrue<Equal<typeof event, AbsenceReassignedEvent>>()
          return { ...absence, assigneeId: event.assigneeId }
        },
      },
    },
    DraftAbsence: { decide: { ReassignAbsenceCommand: () => absenceReassignedEvent } },
    ActiveAbsence: { decide: { ReassignAbsenceCommand: () => absenceReassignedEvent } },
    ArchivedAbsence: {},
    DiscardedAbsence: {},
  },
})

// any-decide: every state and every union of states, with the any handler's own result.
type ForceReassignDecision = Result.Result<AbsenceReassignedEvent, AssigneeNotInOrganizationError>
const forceReassignDecisionOfArchived = WithAny.decide({ absence: archivedAbsence, command: forceReassignAbsenceCommand, now })
expectTrue<Equal<typeof forceReassignDecisionOfArchived, ForceReassignDecision>>()
const forceReassignDecisionOfAnyAbsence = WithAny.decide({ absence: anyAbsence, command: forceReassignAbsenceCommand, now })
expectTrue<Equal<typeof forceReassignDecisionOfAnyAbsence, ForceReassignDecision>>()
const forceReassignDecisionOfEditable = WithAny.decide({ absence: editableAbsence, command: forceReassignAbsenceCommand, now })
expectTrue<Equal<typeof forceReassignDecisionOfEditable, ForceReassignDecision>>()
// @ts-expect-error any is not start: the command needs an absence
WithAny.decide({ command: forceReassignAbsenceCommand, now })
WithAny.decide({
  // @ts-expect-error a state-block command keeps its states: an ArchivedAbsence cannot be reassigned
  absence: archivedAbsence,
  command: reassignAbsenceCommand, now,
})

// any-evolve: the caller's state type comes back.
const activeAbsenceAfterAnyEvolve = WithAny.evolve({ absence: activeAbsence, event: absenceReassignedEvent })
expectTrue<Equal<typeof activeAbsenceAfterAnyEvolve, ActiveAbsence>>()
const archivedAbsenceAfterAnyEvolve = WithAny.evolve({ absence: archivedAbsence, event: absenceReassignedEvent })
expectTrue<Equal<typeof archivedAbsenceAfterAnyEvolve, ArchivedAbsence>>()
const editableAbsenceAfterAnyEvolve = WithAny.evolve({ absence: editableAbsence, event: absenceReassignedEvent })
expectTrue<Equal<typeof editableAbsenceAfterAnyEvolve, DraftAbsence | ActiveAbsence>>()
// @ts-expect-error any is not start: the event needs an absence
WithAny.evolve({ event: absenceReassignedEvent })

// any-evolve returns the state it got, so it cannot build another state.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ReassignAbsenceCommand },
  events: { AbsenceReassignedEvent },
  handlers: {
    start: {},
    any: {
      decide: { ReassignAbsenceCommand: () => absenceReassignedEvent },
      evolve: {
        // @ts-expect-error DraftAbsence is not the state the handler got
        AbsenceReassignedEvent: ({ absence, event }) => DraftAbsence.make({ ...absence, _tag: "DraftAbsence", assigneeId: event.assigneeId }),
      },
    },
    DraftAbsence: {},
    ActiveAbsence: {},
  },
})

// A command or event handled in any and in a state block or start is reported on the state block's or start's key.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ReassignAbsenceCommand, DraftAbsenceCommand },
  events: { AbsenceReassignedEvent, AbsenceDraftedEvent },
  handlers: {
    start: {
      decide: {
        // @ts-expect-error DraftAbsenceCommand is also decided in any
        DraftAbsenceCommand: () => absenceDraftedEvent,
      },
      evolve: {
        // @ts-expect-error AbsenceDraftedEvent is also evolved in any
        AbsenceDraftedEvent: () => draftAbsence,
      },
    },
    any: {
      decide: { ReassignAbsenceCommand: () => absenceReassignedEvent, DraftAbsenceCommand: () => absenceDraftedEvent },
      evolve: { AbsenceReassignedEvent: ({ absence }) => absence, AbsenceDraftedEvent: ({ absence }) => absence },
    },
    DraftAbsence: {
      decide: {
        // @ts-expect-error ReassignAbsenceCommand is also decided in any
        ReassignAbsenceCommand: () => absenceReassignedEvent,
      },
      evolve: {
        // @ts-expect-error AbsenceReassignedEvent is also evolved in any
        AbsenceReassignedEvent: () => draftAbsence,
      },
    },
    ActiveAbsence: {},
  },
})

// any and start are block names, so no state may carry them.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: {
    DraftAbsence,
    // @ts-expect-error any is the block of every state
    any: Schema.TaggedStruct("any", {}),
    // @ts-expect-error start is the block of no state
    start: Schema.TaggedStruct("start", {}),
  },
  commands: {},
  events: {},
  handlers: { start: {}, DraftAbsence: {}, any: {} },
})

// any keeps the key checks of a state block.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ReassignAbsenceCommand },
  events: { AbsenceReassignedEvent },
  handlers: {
    start: {},
    any: {
      decide: {
        ReassignAbsenceCommand: () => absenceReassignedEvent,
        // @ts-expect-error ArchiveAbsenceCommand is not in commands
        ArchiveAbsenceCommand: () => absenceReassignedEvent,
      },
      evolve: { AbsenceReassignedEvent: ({ absence }) => absence },
      // @ts-expect-error a block holds only decide and evolve
      react: {},
    },
    DraftAbsence: {},
    ActiveAbsence: {},
  },
})

// The exhaustiveness gap: with no decide handler at all, an undecided command is reported on every evolve handler.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      evolve: {
        // @ts-expect-error no block decides ActivateAbsenceCommand
        AbsenceActivatedEvent: () => activeAbsence,
      },
    },
    ActiveAbsence: {},
  },
})

// With no evolve handler at all, an unevolved event is reported on every decide handler.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: {
        // @ts-expect-error no block evolves AbsenceActivatedEvent
        ActivateAbsenceCommand: () => absenceActivatedEvent,
      },
    },
    ActiveAbsence: {},
  },
})

// With no handler at all, both are reported on every empty block and every empty decide / evolve.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ActivateAbsenceCommand },
  events: { AbsenceActivatedEvent },
  handlers: {
    // @ts-expect-error no block decides ActivateAbsenceCommand, no block evolves AbsenceActivatedEvent
    start: {},
    DraftAbsence: {
      // @ts-expect-error no block decides ActivateAbsenceCommand, no block evolves AbsenceActivatedEvent
      decide: {},
      // @ts-expect-error no block decides ActivateAbsenceCommand, no block evolves AbsenceActivatedEvent
      evolve: {},
    },
    // @ts-expect-error no block decides ActivateAbsenceCommand, no block evolves AbsenceActivatedEvent
    ActiveAbsence: {},
  },
})

// The full absence aggregate: withdraw and reschedule are decided under both editable states, each with its own result.
declare const withdrawAbsenceCommand: WithdrawAbsenceCommand
declare const rescheduleAbsenceCommand: RescheduleAbsenceCommand
declare const absenceWithdrawnEvent: AbsenceWithdrawnEvent
declare const absenceRescheduledEvent: AbsenceRescheduledEvent
const withdrawDecision = Absence.decide({ absence: editableAbsence, command: withdrawAbsenceCommand, now })
expectTrue<Equal<typeof withdrawDecision, Result.Result<AbsenceWithdrawnEvent, NotAllowedToDeleteAbsenceError>>>()
const rescheduleDecision = Absence.decide({ absence: draftAbsence, command: rescheduleAbsenceCommand, now })
expectTrue<Equal<typeof rescheduleDecision, Result.Result<
  AbsenceRescheduledEvent, NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError | InvalidPeriodError
>>>()
Absence.decide({
  // @ts-expect-error an ArchivedAbsence cannot be withdrawn
  absence: archivedAbsence,
  command: withdrawAbsenceCommand, now,
})
const absenceAfterWithdraw = Absence.evolve({ absence: editableAbsence, event: absenceWithdrawnEvent })
expectTrue<Equal<typeof absenceAfterWithdraw, DiscardedAbsence | ArchivedAbsence>>()
const draftAbsenceAfterWithdraw = Absence.evolve({ absence: draftAbsence, event: absenceWithdrawnEvent })
expectTrue<Equal<typeof draftAbsenceAfterWithdraw, DiscardedAbsence>>()
const absenceAfterReschedule = Absence.evolve({ absence: editableAbsence, event: absenceRescheduledEvent })
expectTrue<Equal<typeof absenceAfterReschedule, DraftAbsence | ActiveAbsence>>()
const activeAbsenceAfterReschedule = Absence.evolve({ absence: activeAbsence, event: absenceRescheduledEvent })
expectTrue<Equal<typeof activeAbsenceAfterReschedule, ActiveAbsence>>()

// ends: a test-only aggregate, since the absence aggregate archives instead of deleting.
// The terminal event's decide works like any other, per state block.
declare const deleteAbsenceCommand: DeleteAbsenceCommand
declare const absenceDeletedEvent: AbsenceDeletedEvent
const WithEnds = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DeleteAbsenceCommand },
  events: { AbsenceDeletedEvent },
  ends: { AbsenceDeletedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: {
        DeleteAbsenceCommand: ({ absence, command, now }) => Result.gen(function* () {
          yield* checkPolicies(withdrawAbsencePolicies, { absence, ...command, now })
          return absenceDeletedEvent
        }),
      },
    },
    ActiveAbsence: {
      decide: {
        DeleteAbsenceCommand: ({ absence, command, now }) => Result.gen(function* () {
          yield* checkPolicies(withdrawAbsencePolicies, { absence, ...command, now })
          return absenceDeletedEvent
        }),
      },
    },
    ArchivedAbsence: {},
  },
})
type DeleteDecision = Result.Result<AbsenceDeletedEvent, NotAllowedToDeleteAbsenceError>
const deleteDecisionOfDraft = WithEnds.decide({ absence: draftAbsence, command: deleteAbsenceCommand, now })
expectTrue<Equal<typeof deleteDecisionOfDraft, DeleteDecision>>()
const deleteDecisionOfEditable = WithEnds.decide({ absence: editableAbsence, command: deleteAbsenceCommand, now })
expectTrue<Equal<typeof deleteDecisionOfEditable, DeleteDecision>>()
WithEnds.decide({
  // @ts-expect-error an ArchivedAbsence cannot be deleted
  absence: archivedAbsence,
  command: deleteAbsenceCommand, now,
})
// @ts-expect-error no state exists after AbsenceDeletedEvent
WithEnds.evolve({ absence: activeAbsence, event: absenceDeletedEvent })

// ends: an evolve handler for a terminal event is refused in start, in a state block and in any.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DeleteAbsenceCommand },
  events: { AbsenceDeletedEvent },
  ends: { AbsenceDeletedEvent },
  handlers: {
    start: {
      evolve: {
        // @ts-expect-error AbsenceDeletedEvent is in ends
        AbsenceDeletedEvent: () => draftAbsence,
      },
    },
    DraftAbsence: {
      decide: { DeleteAbsenceCommand: () => absenceDeletedEvent },
      evolve: {
        // @ts-expect-error AbsenceDeletedEvent is in ends
        AbsenceDeletedEvent: () => draftAbsence,
      },
    },
    ActiveAbsence: {},
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DeleteAbsenceCommand },
  events: { AbsenceDeletedEvent },
  ends: { AbsenceDeletedEvent },
  handlers: {
    start: {},
    any: {
      decide: { DeleteAbsenceCommand: () => absenceDeletedEvent },
      evolve: {
        // @ts-expect-error AbsenceDeletedEvent is in ends
        AbsenceDeletedEvent: ({ absence }) => absence,
      },
    },
    DraftAbsence: {},
    ActiveAbsence: {},
  },
})

// ends: only events of the aggregate.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DeleteAbsenceCommand },
  events: { AbsenceDeletedEvent },
  ends: {
    AbsenceDeletedEvent,
    // @ts-expect-error AbsenceArchivedEvent is not in events
    AbsenceArchivedEvent,
  },
  handlers: {
    start: {},
    DraftAbsence: { decide: { DeleteAbsenceCommand: () => absenceDeletedEvent } },
    ActiveAbsence: {},
  },
})

// ends: without it, the deleted event is one that no block evolves.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { DeleteAbsenceCommand },
  events: { AbsenceDeletedEvent },
  handlers: {
    start: {},
    DraftAbsence: {
      decide: {
        // @ts-expect-error no block evolves AbsenceDeletedEvent, and it is not in ends
        DeleteAbsenceCommand: () => absenceDeletedEvent,
      },
    },
    ActiveAbsence: {},
  },
})

// Coverage: a block evolves every event its decide can return, itself or through any, unless the event is in ends.
declare const activatedOrArchivedEvent: AbsenceActivatedEvent | AbsenceArchivedEvent
declare const archiveDecisionResult: Result.Result<AbsenceArchivedEvent, AbsenceOngoingError>
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence, ArchivedAbsence },
  commands: { DraftAbsenceCommand, ActivateAbsenceCommand, ArchiveAbsenceCommand, ReassignAbsenceCommand, DeleteAbsenceCommand },
  events: { AbsenceDraftedEvent, AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceReassignedEvent, AbsenceDeletedEvent },
  ends: { AbsenceDeletedEvent },
  handlers: {
    start: {
      decide: {
        // @ts-expect-error start decides AbsenceReassignedEvent, which only any evolves, and start has no state for any
        DraftAbsenceCommand: () => absenceReassignedEvent,
      },
      evolve: { AbsenceDraftedEvent: () => draftAbsence },
    },
    any: { evolve: { AbsenceReassignedEvent: ({ absence }) => absence } },
    DraftAbsence: {
      decide: {
        // @ts-expect-error a bare AbsenceArchivedEvent, which only ActiveAbsence evolves
        ArchiveAbsenceCommand: () => absenceArchivedEvent,
        // @ts-expect-error one member of the union, AbsenceArchivedEvent, is not evolved here
        ActivateAbsenceCommand: () => activatedOrArchivedEvent,
        ReassignAbsenceCommand: () => absenceReassignedEvent,
        DeleteAbsenceCommand: () => absenceDeletedEvent,
      },
      evolve: { AbsenceActivatedEvent: () => activeAbsence },
    },
    ActiveAbsence: {
      decide: { ArchiveAbsenceCommand: () => archiveDecisionResult },
      evolve: { AbsenceArchivedEvent: () => archivedAbsence },
    },
    ArchivedAbsence: {
      decide: {
        // @ts-expect-error a Result of AbsenceArchivedEvent, which only ActiveAbsence evolves
        ArchiveAbsenceCommand: () => archiveDecisionResult,
      },
    },
  },
})

// Coverage: an any decide is applied by any's evolve, or by the evolve of every state block.
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ReassignAbsenceCommand },
  events: { AbsenceReassignedEvent },
  handlers: {
    start: {},
    any: { decide: { ReassignAbsenceCommand: () => absenceReassignedEvent } },
    DraftAbsence: { evolve: { AbsenceReassignedEvent: () => draftAbsence } },
    ActiveAbsence: { evolve: { AbsenceReassignedEvent: () => activeAbsence } },
  },
})
Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ReassignAbsenceCommand },
  events: { AbsenceReassignedEvent },
  handlers: {
    start: {},
    any: {
      decide: {
        // @ts-expect-error ActiveAbsence has no evolve for AbsenceReassignedEvent
        ReassignAbsenceCommand: () => absenceReassignedEvent,
      },
    },
    DraftAbsence: { evolve: { AbsenceReassignedEvent: () => draftAbsence } },
    ActiveAbsence: {},
  },
})

// Forwarding to a named transition keeps its written result type, for each state and for their union.
declare const absenceReassignCommand: AbsenceReassignCommand
const rescheduleDecisionOfDraft = Absence.decide({ absence: draftAbsence, command: rescheduleAbsenceCommand, now })
expectTrue<Equal<typeof rescheduleDecisionOfDraft, ReturnType<typeof rescheduleAbsence>>>()
const rescheduleDecisionOfActive = Absence.decide({ absence: activeAbsence, command: rescheduleAbsenceCommand, now })
expectTrue<Equal<typeof rescheduleDecisionOfActive, ReturnType<typeof rescheduleAbsence>>>()
const rescheduleDecisionOfEditable = Absence.decide({ absence: editableAbsence, command: rescheduleAbsenceCommand, now })
expectTrue<Equal<typeof rescheduleDecisionOfEditable, ReturnType<typeof rescheduleAbsence>>>()
const reassignDecisionOfEditable = Absence.decide({ absence: editableAbsence, command: absenceReassignCommand, now })
expectTrue<Equal<typeof reassignDecisionOfEditable, ReturnType<typeof reassignAbsence>>>()
const withdrawDecisionOfEditable = Absence.decide({ absence: editableAbsence, command: withdrawAbsenceCommand, now })
expectTrue<Equal<typeof withdrawDecisionOfEditable, ReturnType<typeof withdrawAbsence>>>()

// Type helpers: the unions of an aggregate, and the errors of one command over every block that decides it.
type AbsenceAggregate = typeof Absence
expectTrue<Equal<Aggregate.State<AbsenceAggregate>, AbsenceState>>()
expectTrue<Equal<Aggregate.Command<AbsenceAggregate>,
  | DraftAbsenceCommand | RescheduleAbsenceCommand | AbsenceReassignCommand | ActivateAbsenceCommand | ArchiveAbsenceCommand
  | WithdrawAbsenceCommand
>>()
expectTrue<Equal<Aggregate.Event<AbsenceAggregate>,
  | AbsenceDraftedEvent | AbsenceRescheduledEvent | AbsenceReassignedEvent | AbsenceActivatedEvent | AbsenceArchivedEvent
  | AbsenceWithdrawnEvent
>>()
expectTrue<Equal<Aggregate.Errors<AbsenceAggregate, "ArchiveAbsenceCommand">, NotAllowedToEditAbsenceError | AbsenceOngoingError>>()
expectTrue<Equal<
  Aggregate.Errors<AbsenceAggregate, "RescheduleAbsenceCommand">,
  NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError | InvalidPeriodError
>>()
expectTrue<Equal<
  Aggregate.Errors<AbsenceAggregate, "DraftAbsenceCommand">,
  AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError
>>()
expectTrue<Equal<Aggregate.Errors<typeof WithoutRule, "ArchiveAbsenceCommand">, never>>()
// @ts-expect-error DeleteAbsenceCommand is not a command of the absence aggregate
export type ErrorsOfUnknownCommand = Aggregate.Errors<AbsenceAggregate, "DeleteAbsenceCommand">

// Errors unions the blocks: one command with a different refusal per state.
declare const archiveDecisionWithAnotherError: Result.Result<AbsenceArchivedEvent, NotAllowedToDeleteAbsenceError>
const WithErrorsPerBlock = Aggregate.make("Absence", {
  id: AbsenceId,
  states: { DraftAbsence, ActiveAbsence },
  commands: { ArchiveAbsenceCommand },
  events: { AbsenceArchivedEvent },
  ends: { AbsenceArchivedEvent },
  handlers: {
    start: {},
    DraftAbsence: { decide: { ArchiveAbsenceCommand: () => archiveDecisionResult } },
    ActiveAbsence: { decide: { ArchiveAbsenceCommand: () => archiveDecisionWithAnotherError } },
  },
})
expectTrue<Equal<Aggregate.Errors<typeof WithErrorsPerBlock, "ArchiveAbsenceCommand">, AbsenceOngoingError | NotAllowedToDeleteAbsenceError>>()
