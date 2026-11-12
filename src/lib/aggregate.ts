import type { DateTime, Result, Schema } from "effect"

type ReservedBlockName = "start" | "any"
type SchemasByTag<Schemas> = { readonly [Tag in keyof Schemas]: Schema.Top & { readonly Type: { readonly _tag: Tag & string } } }
type StateSchemasByTag<States> = {
  readonly [Tag in keyof States]: Tag extends ReservedBlockName ? never : Schema.Top & { readonly Type: { readonly _tag: Tag & string } }
}
type EndsOfEvents<Ends, Events> = { readonly [Tag in keyof Ends]: Tag extends keyof Events ? Events[Tag] : never }
type AnySchemasByTag = { readonly [Tag in string]: { readonly Type: { readonly _tag: string } } }
type TypeUnion<Schemas extends AnySchemasByTag> = Schemas[keyof Schemas]["Type"]

type StateArgument<Name extends string, State> = { readonly [Key in Uncapitalize<Name>]: State }
type HandlerKind = "decide" | "evolve"

type DecideHandlers<StateInput, Commands extends AnySchemasByTag, Events extends AnySchemasByTag> = {
  readonly [Tag in keyof Commands]?: (
    input: StateInput & { readonly command: Commands[Tag]["Type"]; readonly now: DateTime.Utc },
  ) => TypeUnion<Events> | Result.Result<TypeUnion<Events>, unknown>
}
type EvolveHandlers<StateInput, States extends AnySchemasByTag, Events extends AnySchemasByTag> = {
  readonly [Tag in keyof Events]?: (input: StateInput & { readonly event: Events[Tag]["Type"] }) => TypeUnion<States>
}
type EvolveHandlersOfAnyState<Name extends string, States extends AnySchemasByTag, Events extends AnySchemasByTag> = {
  readonly [Tag in keyof Events]?: <State extends TypeUnion<States>>(
    input: StateArgument<Name, State> & { readonly event: Events[Tag]["Type"] },
  ) => State
}
type HandlerBlock<StateInput, States extends AnySchemasByTag, Commands extends AnySchemasByTag, Events extends AnySchemasByTag> = {
  readonly decide?: DecideHandlers<StateInput, Commands, Events>
  readonly evolve?: EvolveHandlers<StateInput, States, Events>
}
type HandlerBlocks<Name extends string, States extends AnySchemasByTag, Commands extends AnySchemasByTag, Events extends AnySchemasByTag> =
  & { readonly start: HandlerBlock<{}, States, Commands, Events> }
  & {
    readonly any?: {
      readonly decide?: DecideHandlers<StateArgument<Name, TypeUnion<States>>, Commands, Events>
      readonly evolve?: EvolveHandlersOfAnyState<Name, States, Events>
    }
  }
  & { readonly [Tag in keyof States]: HandlerBlock<StateArgument<Name, States[Tag]["Type"]>, States, Commands, Events> }

type HandlersOfKind<Block, Kind extends HandlerKind> = Block extends { readonly [Key in Kind]: infer Handlers } ? Handlers : {}
type HandledTags<Blocks, Kind extends HandlerKind> = { [Block in keyof Blocks]: keyof HandlersOfKind<Blocks[Block], Kind> }[keyof Blocks]
type TagsHandledInAny<Blocks, Kind extends HandlerKind> = Blocks extends { readonly any: infer AnyBlock } ? keyof HandlersOfKind<AnyBlock, Kind> : never

type EveryCommandDecided<Blocks, Commands> = [Exclude<keyof Commands, HandledTags<Blocks, "decide">>] extends [never]
  ? unknown
  : { readonly "commands that no block decides": Exclude<keyof Commands, HandledTags<Blocks, "decide">> }
type EveryEventEvolved<Blocks, Events, Ends> = [Exclude<keyof Events, keyof Ends | HandledTags<Blocks, "evolve">>] extends [never]
  ? unknown
  : { readonly "events that no block evolves": Exclude<keyof Events, keyof Ends | HandledTags<Blocks, "evolve">> }
type NotAlsoHandledInAny<Blocks, Block, Kind extends HandlerKind, Tag> = Block extends "any"
  ? unknown
  : Tag extends TagsHandledInAny<Blocks, Kind> ? { readonly "also handled in the any block": Tag } : unknown

type EventTagOfDecision<Decision> =
  (Decision extends Result.Result<infer Event, unknown> ? Event : Decision) extends { readonly _tag: infer Tag } ? Tag : never
type TagsEveryStateEvolves<Blocks, States, Events> = {
  [Tag in keyof Events]: [keyof States] extends [BlockTagsHandling<Blocks, "evolve", Tag>] ? Tag : never
}[keyof Events]
type TagsBlockEvolves<Blocks, Block extends keyof Blocks, States, Events> =
  | keyof HandlersOfKind<Blocks[Block], "evolve">
  | (Block extends "start" ? never : TagsHandledInAny<Blocks, "evolve">)
  | (Block extends "any" ? TagsEveryStateEvolves<Blocks, States, Events> : never)
type UnappliedEventTags<Blocks, Block extends keyof Blocks, Handler, States, Events, Ends> = Exclude<
  Handler extends (input: never) => infer Decision ? EventTagOfDecision<Decision> : never,
  keyof Ends | TagsBlockEvolves<Blocks, Block, States, Events>
>
type AppliesWhatItDecides<Blocks, Block extends keyof Blocks, Handler, States, Events, Ends> =
  [UnappliedEventTags<Blocks, Block, Handler, States, Events, Ends>] extends [never]
    ? unknown
    : { readonly "events this handler decides that its block cannot evolve": UnappliedEventTags<Blocks, Block, Handler, States, Events, Ends> }
type NotAnEnd<Ends, Tag> = Tag extends keyof Ends ? { readonly "ends lists this event, so no state is left to evolve": Tag } : unknown

type CheckedDecideHandler<Blocks, Commands, Events, Ends> =
  & EveryCommandDecided<Blocks, Commands>
  & ([HandledTags<Blocks, "evolve">] extends [never] ? EveryEventEvolved<Blocks, Events, Ends> : unknown)
type CheckedEvolveHandler<Blocks, Commands, Events, Ends> =
  & EveryEventEvolved<Blocks, Events, Ends>
  & ([HandledTags<Blocks, "decide">] extends [never] ? EveryCommandDecided<Blocks, Commands> : unknown)
type CheckedWithoutAnyHandler<Blocks, Commands, Events, Ends> = [HandledTags<Blocks, "decide"> | HandledTags<Blocks, "evolve">] extends [never]
  ? EveryCommandDecided<Blocks, Commands> & EveryEventEvolved<Blocks, Events, Ends>
  : unknown

type CheckedHandlers<Blocks, States, Commands, Events, Ends> = {
  readonly [Block in keyof Blocks]: Block extends ReservedBlockName | keyof States
    ? [keyof Blocks[Block]] extends [never]
      ? CheckedWithoutAnyHandler<Blocks, Commands, Events, Ends>
      : { readonly [Kind in keyof Blocks[Block]]:
          Kind extends "decide"
            ? [keyof Blocks[Block][Kind]] extends [never]
              ? CheckedWithoutAnyHandler<Blocks, Commands, Events, Ends>
              : { readonly [Tag in keyof Blocks[Block][Kind]]: Tag extends keyof Commands
                ? & CheckedDecideHandler<Blocks, Commands, Events, Ends>
                  & NotAlsoHandledInAny<Blocks, Block, Kind, Tag>
                  & AppliesWhatItDecides<Blocks, Block, Blocks[Block][Kind][Tag], States, Events, Ends>
                : never }
          : Kind extends "evolve"
            ? [keyof Blocks[Block][Kind]] extends [never]
              ? CheckedWithoutAnyHandler<Blocks, Commands, Events, Ends>
              : { readonly [Tag in keyof Blocks[Block][Kind]]: Tag extends keyof Events
                ? CheckedEvolveHandler<Blocks, Commands, Events, Ends> & NotAlsoHandledInAny<Blocks, Block, Kind, Tag> & NotAnEnd<Ends, Tag>
                : never }
          : never }
    : never
}

type BlockTagsHandling<Blocks, Kind extends HandlerKind, Tag extends PropertyKey> = {
  [Block in keyof Blocks]: [Tag] extends [keyof HandlersOfKind<Blocks[Block], Kind>] ? Block : never
}[keyof Blocks]
type HandlerResult<Blocks, Block, Kind extends HandlerKind, Tag extends PropertyKey> =
  Block extends keyof Blocks
    ? HandlersOfKind<Blocks[Block], Kind> extends { readonly [Key in Tag]: (input: never) => infer Returned } ? Returned : never
    : never

type StatesHandling<States extends AnySchemasByTag, Blocks, Kind extends HandlerKind, Tag extends PropertyKey> =
  States[BlockTagsHandling<Blocks, Kind, Tag> & keyof States]["Type"]
type StateInput<Name extends string, States extends AnySchemasByTag, Blocks, Kind extends HandlerKind, Tag extends PropertyKey, State> =
  [Tag] extends [keyof HandlersOfKind<Blocks[keyof Blocks & "start"], Kind>]
    ? {}
    : [Tag] extends [TagsHandledInAny<Blocks, Kind>]
      ? StateArgument<Name, State>
      : StateArgument<Name, [State] extends [StatesHandling<States, Blocks, Kind, Tag>] ? State : StatesHandling<States, Blocks, Kind, Tag>>
type BlockOfState<State extends { readonly _tag: string }> = [State] extends [never] ? "start" : State["_tag"]

declare const BlocksOfAggregate: unique symbol

export type Aggregate<
  Name extends string, States extends AnySchemasByTag, Commands extends AnySchemasByTag, Events extends AnySchemasByTag, Ends, Blocks,
> = {
  readonly name: Name
  readonly states: States
  readonly commands: Commands
  readonly events: Events
  readonly [BlocksOfAggregate]?: Blocks
  readonly decide: <Command extends TypeUnion<Commands>, State extends TypeUnion<States> = never>(
    input: { readonly command: Command; readonly now: DateTime.Utc } & StateInput<Name, States, Blocks, "decide", Command["_tag"], State>,
  ) => [Command["_tag"]] extends [TagsHandledInAny<Blocks, "decide">]
    ? HandlerResult<Blocks, "any", "decide", Command["_tag"]>
    : HandlerResult<Blocks, BlockOfState<State>, "decide", Command["_tag"]>
  readonly evolve: <Event extends Exclude<TypeUnion<Events>, Events[keyof Ends & keyof Events]["Type"]>, State extends TypeUnion<States> = never>(
    input: { readonly event: Event } & StateInput<Name, States, Blocks, "evolve", Event["_tag"], State>,
  ) => [Event["_tag"]] extends [TagsHandledInAny<Blocks, "evolve">]
    ? State
    : HandlerResult<Blocks, BlockOfState<State>, "evolve", Event["_tag"]>
}

type ErrorOfDecision<Decision> = Decision extends Result.Result<unknown, infer Error> ? Error : never

export declare namespace Aggregate {
  export type State<Self extends { readonly states: AnySchemasByTag }> = TypeUnion<Self["states"]>
  export type Command<Self extends { readonly commands: AnySchemasByTag }> = TypeUnion<Self["commands"]>
  export type Event<Self extends { readonly events: AnySchemasByTag }> = TypeUnion<Self["events"]>
  export type Errors<
    Self extends { readonly commands: AnySchemasByTag; readonly [BlocksOfAggregate]?: unknown },
    CommandTag extends keyof Self["commands"],
  > = ErrorOfDecision<
    HandlerResult<NonNullable<Self[typeof BlocksOfAggregate]>, keyof NonNullable<Self[typeof BlocksOfAggregate]>, "decide", CommandTag>
  >
}

type Tagged = { readonly _tag: string }
type UntypedHandler = (input: object) => unknown
type UntypedBlocks = { readonly [Block in string]?: { readonly [Kind in HandlerKind]?: { readonly [Tag in string]?: UntypedHandler } } }

const make = <
  const Name extends string,
  States extends StateSchemasByTag<States>,
  Commands extends SchemasByTag<Commands>,
  Events extends SchemasByTag<Events>,
  Ends extends EndsOfEvents<Ends, Events> = {},
  Blocks extends HandlerBlocks<Name, States, Commands, Events> = HandlerBlocks<Name, States, Commands, Events>,
>(
  name: Name,
  definition: {
    readonly id: Schema.Top
    readonly states: States
    readonly commands: Commands
    readonly events: Events
    readonly ends?: Ends
    readonly handlers: Blocks & CheckedHandlers<Blocks, States, Commands, Events, Ends>
  },
): Aggregate<Name, States, Commands, Events, Ends, Blocks> => {
  const stateArgumentName = `${name.charAt(0).toLowerCase()}${name.slice(1)}`
  // Cast: the lookup below is by runtime tag, which the mapped type Blocks cannot be indexed with.
  const blocks = definition.handlers as UntypedBlocks
  const callHandler = ({ kind, input, tagged }: { kind: HandlerKind; input: { readonly [argument: string]: unknown }; tagged: Tagged }) => {
    const state = input[stateArgumentName] as Tagged | undefined // Cast: Aggregate's signatures only let a state of States in.
    const blockName = state === undefined ? "start" : state._tag
    const handler = blocks[blockName]?.[kind]?.[tagged._tag] ?? (state === undefined ? undefined : blocks.any?.[kind]?.[tagged._tag])
    if (handler === undefined) throw new Error(`${name}: block ${blockName} has no ${kind} for ${tagged._tag}`)
    return handler(input)
  }
  // Cast: Aggregate's signatures derive each result from Blocks; the untyped lookup returns unknown.
  return {
    name,
    states: definition.states,
    commands: definition.commands,
    events: definition.events,
    decide: (input: { readonly command: Tagged }) => callHandler({ kind: "decide", input, tagged: input.command }),
    evolve: (input: { readonly event: Tagged }) => callHandler({ kind: "evolve", input, tagged: input.event }),
  } as Aggregate<Name, States, Commands, Events, Ends, Blocks>
}

export const Aggregate = { make }
