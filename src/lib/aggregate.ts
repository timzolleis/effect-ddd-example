import type { DateTime, Result, Schema } from "effect"

type Tagged = { readonly _tag: string }
type SchemasByTag<Schemas> = { readonly [Tag in keyof Schemas]: Schema.Top & { readonly Type: { readonly _tag: Tag & string } } }
type StateSchemasByTag<States> = {
  readonly [Tag in keyof States]: Tag extends "initial" ? never : Schema.Top & { readonly Type: { readonly _tag: Tag & string } }
}
type AnySchemasByTag = { readonly [Tag in string]: { readonly Type: Tagged } }
type TypeUnion<Schemas extends AnySchemasByTag> = Schemas[keyof Schemas]["Type"]
type TaggedStructSchema<Type> = Schema.Top & {
  readonly Type: Type
  readonly fields: { readonly _tag: { readonly schema: { readonly literal: string } } }
}

type StateArgument<Name extends string, State> = { readonly [Key in Uncapitalize<Name>]: State }
type StateFields<State> = State extends unknown ? Omit<State, "_tag"> : never
type Now = { readonly now: DateTime.Utc }

type FromEntry = "initial" | { readonly Type: Tagged }
type StateOfFrom<From> = From extends ReadonlyArray<infer Entry> ? Exclude<Entry, "initial"> extends { readonly Type: infer State } ? State : never : never
type StateTagOfFrom<From> = From extends ReadonlyArray<infer Entry>
  ? (Entry extends "initial" ? "initial" : never) | (StateOfFrom<From> extends Tagged ? StateOfFrom<From>["_tag"] : never)
  : never
type CheckedFrom<States, From> = {
  readonly [Index in keyof From]: From[Index] extends "initial"
    ? From extends readonly ["initial"] ? From[Index] : { readonly "initial cannot share a command with a state": From }
    : From[Index] extends States[keyof States] ? From[Index]
    : { readonly "no state of the aggregate has this name": From[Index] extends { readonly Type: Tagged } ? From[Index]["Type"]["_tag"] : From[Index] }
}

type DecideInput<Name extends string, States extends AnySchemasByTag, From, Command> = ([StateOfFrom<From>] extends [never] ? {}
  : StateArgument<Name, Extract<StateOfFrom<From>, TypeUnion<States>>>)
  & { readonly command: Command }
  & Now
type EvolveInput<Name extends string, States extends AnySchemasByTag, StateTag, Event> = StateTag extends keyof States
  ? StateArgument<Name, StateFields<States[StateTag]["Type"]>> & { readonly event: Event }
  : StateTag extends "initial" ? { readonly event: Event }
  // any: a state in from but not in states is already an error on its from entry; one more per handler would only repeat it.
  : StateArgument<Name, any> & { readonly event: Event }
type EventTypeOf<EventSchema> = EventSchema extends { readonly Type: infer Event } ? Event : never
type CommandTypeOf<Commands extends AnySchemasByTag, Tag> = Commands[Tag & keyof Commands]["Type"]

type RecordsOfCommands<Commands> = { readonly [Tag in keyof Commands]: unknown }
type OnlyCommandsOfTheAggregate<Commands, Froms> = {
  readonly [Tag in Exclude<keyof Froms, keyof Commands>]: { readonly "no command of the aggregate has this name": Tag }
}
type CommandTagsDecidingSameEvent<Events> = {
  [Tag in keyof Events]: EventTypeOf<Events[Tag]> extends { readonly _tag: (EventTypeOf<Events[Exclude<keyof Events, Tag>]> & Tagged)["_tag"] }
    ? Tag : never
}[keyof Events]
type OneCommandPerEvent<Events> = [CommandTagsDecidingSameEvent<Events>] extends [never]
  ? unknown
  : { readonly "commands that decide the same event, so replay cannot tell their evolves apart": CommandTagsDecidingSameEvent<Events> }
type NextStateOfEvolve<Evolve> = Evolve extends (input: never) => infer Next ? Next : unknown
type NextStates<Evolves> = { [Tag in keyof Evolves]: Evolves[Tag] extends object ? NextStateOfEvolve<Evolves[Tag][keyof Evolves[Tag]]> : unknown }[keyof Evolves]
type EveryStateReachable<States, Evolves> = unknown extends NextStates<Evolves> ? unknown
  : [Exclude<keyof States, (NextStates<Evolves> & Tagged)["_tag"]>] extends [never] ? unknown
  : { readonly "states that no evolve returns": Exclude<keyof States, (NextStates<Evolves> & Tagged)["_tag"]> }

// any: while a broken definition drops the inferred decides, calls of the other commands keep compiling (the error stays on the definition).
type DecisionOfCall<Decision, EventSchema> = unknown extends Decision ? Result.Result<EventTypeOf<EventSchema>, any> : Decision
type CommandTagDeciding<Events, EventTag> = { [Tag in keyof Events]: EventTypeOf<Events[Tag]> extends { readonly _tag: EventTag } ? Tag : never }[keyof Events]
type StateInputOfCall<Name extends string, States extends AnySchemasByTag, AcceptingStateTags, State> = [AcceptingStateTags] extends ["initial"]
  ? {}
  : StateArgument<Name, [State] extends [States[AcceptingStateTags & keyof States]["Type"]] ? State : States[AcceptingStateTags & keyof States]["Type"]>
type StateTagOfCall<State extends Tagged> = [State] extends [never] ? "initial" : State["_tag"]
type CommandTagsAcceptedIn<Froms, StateTag> = { [Tag in keyof Froms]: [StateTag] extends [StateTagOfFrom<Froms[Tag]>] ? Tag : never }[keyof Froms]
type CommandAcceptedIn<Commands extends AnySchemasByTag, Froms, State extends Tagged> =
  [State] extends [never] ? TypeUnion<Commands> : CommandTypeOf<Commands, CommandTagsAcceptedIn<Froms, State["_tag"]>>
type IsAny<Type> = 0 extends 1 & Type ? true : false
type StateTagsAccepting<States, Froms, CommandTag, StateTag = "initial" | keyof States> = StateTag extends unknown
  ? [CommandTag] extends [CommandTagsAcceptedIn<Froms, StateTag>] ? StateTag : never
  : never
type StateAccepting<States extends AnySchemasByTag, Froms, Command extends Tagged> =
  States[StateTagsAccepting<States, Froms, Command["_tag"]> & keyof States]["Type"]
type CommandInputOfDecide<Commands extends AnySchemasByTag, States extends AnySchemasByTag, Froms, State extends Tagged, Command extends Tagged> =
  & { readonly command: Command | CommandAcceptedIn<Commands, Froms, State> }
  & (IsAny<Command> extends true ? {}
    : [Command] extends [CommandAcceptedIn<Commands, Froms, State>] ? {}
    : {
      readonly command: {
        readonly command: Command["_tag"]
        readonly "is accepted in": StateTagsAccepting<States, Froms, Command["_tag"]>
        readonly "not in": State["_tag"]
        readonly "which accepts": CommandAcceptedIn<Commands, Froms, State>["_tag"]
      }
    })
type StateOfDecide<States extends AnySchemasByTag, Froms, State extends Tagged, Command extends Tagged> =
  IsAny<State> extends true ? StateAccepting<States, Froms, Command>
  : IsAny<Command> extends true ? State
  : [Command] extends [never] ? State
  : State | StateAccepting<States, Froms, Command>
type StateInputOfDecide<Name extends string, States extends AnySchemasByTag, Froms, State extends Tagged, Command extends Tagged> =
  [State] extends [never] ? "initial" extends StateTagsAccepting<States, Froms, Command["_tag"]> ? {}
    : { readonly [Key in Uncapitalize<Name>]: StateAccepting<States, Froms, Command> }
  : { readonly [Key in Uncapitalize<Name>]: StateOfDecide<States, Froms, State, Command> }
// any: same as DecisionOfCall, for the evolves.
type NextStateOfCall<Evolve, StateTag> = unknown extends Evolve ? any : NextStateOfEvolve<Evolve[StateTag & keyof Evolve]>
type EventSchemasByTag<Events> = {
  readonly [Tag in keyof Events as EventTypeOf<Events[Tag]> extends infer Event extends Tagged ? Event["_tag"] : never]: Events[Tag]
}

export type Aggregate<Name extends string, States extends AnySchemasByTag, Commands extends AnySchemasByTag, Froms, Events, Decisions, Evolves> = {
  readonly name: Name
  readonly states: States
  readonly commands: Commands
  readonly events: EventSchemasByTag<Events>
  readonly accepts: {
    readonly [StateTag in "initial" | keyof States]: ReadonlyArray<CommandTagsAcceptedIn<Froms, StateTag>>
  }
  readonly acceptedIn: { readonly [Tag in keyof Froms]: ReadonlyArray<StateTagOfFrom<Froms[Tag]>> }
  readonly decide: <State extends TypeUnion<States> = never, Command extends TypeUnion<Commands> = never>(
    input:
      & CommandInputOfDecide<Commands, States, Froms, State, Command>
      & Now
      & StateInputOfDecide<Name, States, Froms, State, Command>,
  ) => DecisionOfCall<Decisions[Command["_tag"] & keyof Decisions], Events[Command["_tag"] & keyof Events]>
  readonly evolve: <Event extends EventTypeOf<Events[keyof Events]> & Tagged, State extends TypeUnion<States> = never>(
    input: { readonly event: Event }
      & StateInputOfCall<Name, States, StateTagOfFrom<Froms[CommandTagDeciding<Events, Event["_tag"]> & keyof Froms]>, State>,
  ) => NextStateOfCall<Evolves[CommandTagDeciding<Events, Event["_tag"]> & keyof Evolves], StateTagOfCall<State>>
}

export declare namespace Aggregate {
  export type State<Self extends { readonly states: AnySchemasByTag }> = TypeUnion<Self["states"]>
  export type Command<Self extends { readonly commands: AnySchemasByTag }> = TypeUnion<Self["commands"]>
  export type Event<Self extends { readonly events: AnySchemasByTag }> = TypeUnion<Self["events"]>
  export type Accepts<Self extends { readonly accepts: object }, StateTag extends keyof Self["accepts"]> =
    Self["accepts"][StateTag] extends ReadonlyArray<infer Tag> ? Tag : never
  export type AcceptedIn<Self extends { readonly acceptedIn: object }, CommandTag extends keyof Self["acceptedIn"]> =
    Self["acceptedIn"][CommandTag] extends ReadonlyArray<infer StateTag> ? StateTag : never
}

type UntypedHandler = (input: object) => unknown
type UntypedRecord = {
  readonly from: ReadonlyArray<"initial" | TaggedStructSchema<unknown>>
  readonly event: TaggedStructSchema<unknown>
  readonly decide: UntypedHandler
  readonly evolve: { readonly [StateTag in string]?: UntypedHandler }
}

const make = <
  const Name extends string,
  States extends StateSchemasByTag<States>,
  Commands extends SchemasByTag<Commands>,
  const Froms extends { readonly [Tag in keyof Froms]: ReadonlyArray<FromEntry> },
  Events extends { readonly [Tag in keyof Events]: TaggedStructSchema<Tagged> },
  Decisions,
  Evolves,
>(
  name: Name,
  definition: {
    readonly id: Schema.Top
    readonly states: States & NoInfer<EveryStateReachable<States, Evolves>>
    readonly commands: Commands
    readonly handlers:
      & {
        readonly [Tag in keyof Froms]: {
          readonly from: Froms[Tag] & NoInfer<CheckedFrom<States, Froms[Tag]>>
          readonly evolve: NoInfer<
            & {
              readonly [StateTag in StateTagOfFrom<Froms[Tag]>]: (input: EvolveInput<Name, States, StateTag, EventTypeOf<Events[Tag & keyof Events]>>) =>
                TypeUnion<States>
            }
            & {
              readonly [StateTag in Exclude<"initial" | keyof States, StateTagOfFrom<Froms[Tag]>>]?:
                (input: EvolveInput<Name, States, StateTag, EventTypeOf<Events[Tag & keyof Events]>>) => { readonly "this state is not in from": StateTag }
            }
            & {
              readonly [StateTag in Exclude<keyof Evolves[Tag & keyof Evolves], "initial" | keyof States | StateTagOfFrom<Froms[Tag]>>]:
                { readonly "no state of the aggregate has this name": StateTag }
            }
          >
        }
      }
      & { readonly [Tag in keyof Events]: { readonly event: Events[Tag] } }
      & {
        readonly [Tag in keyof Decisions]: {
          readonly decide: (input: DecideInput<Name, States, Froms[Tag & keyof Froms], CommandTypeOf<Commands, Tag>>) =>
            Decisions[Tag] & NoInfer<EventTypeOf<Events[Tag & keyof Events]> | Result.Result<EventTypeOf<Events[Tag & keyof Events]>, unknown>>
        }
      }
      & { readonly [Tag in keyof Evolves]: { readonly evolve: Evolves[Tag] } }
      & NoInfer<RecordsOfCommands<Commands> & OnlyCommandsOfTheAggregate<Commands, Froms> & OneCommandPerEvent<Events>>
  },
): Aggregate<Name, States, Commands, Froms, Events, Decisions, Evolves> => {
  const stateArgumentName = `${name.charAt(0).toLowerCase()}${name.slice(1)}`
  // Cast: make's signature checks each record; the lookups below are by runtime tag.
  const handlers = definition.handlers as { readonly [Tag in string]: UntypedRecord }
  const tagOfSchema = (schema: TaggedStructSchema<unknown>) => schema.fields._tag.schema.literal
  const recordEntries = Object.entries(handlers).map(([commandTag, record]) => ({
    commandTag,
    record,
    eventTag: tagOfSchema(record.event),
    fromStateTags: record.from.map((entry) => entry === "initial" ? "initial" : tagOfSchema(entry)),
  }))
  const accepts = Object.fromEntries(["initial", ...Object.keys(definition.states)].map((stateTag) => [
    stateTag,
    recordEntries.filter(({ fromStateTags }) => fromStateTags.includes(stateTag)).map(({ commandTag }) => commandTag),
  ]))
  const acceptedIn = Object.fromEntries(recordEntries.map(({ commandTag, fromStateTags }) => [commandTag, fromStateTags]))
  const events = Object.fromEntries(recordEntries.map(({ eventTag, record }) => [eventTag, record.event]))
  const stateOf = (input: object) =>
    (input as { readonly [argument: string]: Tagged | undefined })[stateArgumentName] // Cast: Aggregate's signatures only let a state of States in.
  const stateTagOf = (state: Tagged | undefined) => state === undefined ? "initial" : state._tag
  const decide = (input: { readonly command: Tagged; readonly now: DateTime.Utc }) => {
    const stateTag = stateTagOf(stateOf(input))
    const recordEntry = recordEntries.find(({ commandTag }) => commandTag === input.command._tag)
    if (recordEntry === undefined || !recordEntry.fromStateTags.includes(stateTag)) {
      throw new Error(`${name}: ${stateTag} does not accept ${input.command._tag}`)
    }
    return recordEntry.record.decide(input)
  }
  const evolve = (input: { readonly event: Tagged }) => {
    const state = stateOf(input)
    const stateTag = stateTagOf(state)
    const evolveOfState = recordEntries.find(({ eventTag }) => eventTag === input.event._tag)?.record.evolve[stateTag]
    if (evolveOfState === undefined) throw new Error(`${name}: ${stateTag} has no evolve for ${input.event._tag}`)
    if (state === undefined) return evolveOfState({ event: input.event })
    const { _tag, ...stateFields } = state
    return evolveOfState({ event: input.event, [stateArgumentName]: stateFields })
  }
  const untypedAggregate: object = { name, states: definition.states, commands: definition.commands, events, accepts, acceptedIn, decide, evolve }
  // Cast: Aggregate's signatures derive each result from the records; the untyped lookups return unknown.
  return untypedAggregate as Aggregate<Name, States, Commands, Froms, Events, Decisions, Evolves>
}

export const Aggregate = { make }
