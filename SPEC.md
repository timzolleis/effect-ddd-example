# Absence example: Effect, one schema per state, one service per use case

> **Archived.** The design record of this example, kept in sync with the code. The rules and their reasons live in the `effect-ddd` skill; when the two disagree, the skill wins.

The design of one module, `absence`, in the order you build it: decisions, rules, model, ports, use cases, adapters, HTTP.

Every `ts` and `prisma` block is an excerpt of the code in this repository, except one marked `// not in the example code`. Its first line names the file (relative to `src/`). Imports are left out, and `…` marks an elision. `npm run verify` there generates the client, type-checks, runs the tests against Postgres, and checks every excerpt in this document against the code. `text` blocks are call trees.

Stack: effect 4.0.5, Prisma 7.10 with effect-prisma-generator 0.11, TypeScript 5.9 (`strict`, `exactOptionalPropertyTypes`).

Conventions:
- A function with more than one argument takes one object (`archiveAbsence({ absence, actor, now })`). Single-argument functions stay positional (`publishDomainEvent(event)`).
- Data is plain structs: `Schema.Struct` / `Schema.TaggedStruct` + `type X = typeof X.Type`. Values can be spread (`{ ...draft, createdAt }`). Errors are the only classes. Domain errors are `Data.TaggedError` (yieldable, not a schema, so they can't be encoded into a response by accident); HTTP errors are `Schema.TaggedError` (they must encode).
- Why not `Schema.Class` for data: encoding a class schema checks the value is a real instance. A spread `{ ...instance }` still type-checks but fails at encode with `InvalidType`.
- Behaviour is named module exports (`archiveAbsence`, `createPeriod`), imported by name, no namespace imports.
- Greppable names: every function and method names its subject (`getAbsenceById`, `publishDomainEvent`), never just `getById` / `publish` / `execute`. A translation names its output and its input (`absenceVisibilityFromReader`).
- Errors are written out in every signature, never hidden behind a union alias.
- Time is `DateTime.Utc` (`Schema.DateTimeUtc`) in the model, events, errors, views, and HTTP. `Date` exists only at Prisma. Compare with `DateTime.isLessThan` etc., never `<` or `===`.
- The domain returns `Result`; a use case lifts it with `Effect.fromResult`. A `Result` can't be yielded inside `Effect.gen`.
- An error is an `Effect`: return or `yield*` `new X(…)`, never `Effect.fail(new X(…))`. The domain returns `Result`, so it uses `Result.fail(new X(…))`.
- Comments say why, never what the line already says.

---

## 1. Decisions

| Topic | Choice | Source |
|---|---|---|
| States | One `Schema.TaggedStruct` per state: `DraftAbsence \| ActiveAbsence \| ArchivedAbsence` | library (`AvailableBook` / `BookOnHold`) |
| Transitions | Exported functions (`archiveAbsence`, …) taking a named input type (`ArchiveAbsenceInput`); its `absence` field's type is the state that allows the transition; return `Result<Event, …errors>` | library (`Patron.placeOnHold` returns event), Vernon (intention-revealing names) |
| State check | The repository read narrows: `findActiveAbsenceById` etc. | library (`FindAvailableBook`) |
| Rules | Per transition: policy type `ArchiveAbsencePolicy` over `ArchiveAbsenceInput`, ordered list `archiveAbsencePolicies`; the who-acts policy, if any, is first; `checkPolicies` returns the first rejection | library (`PlacingOnHoldPolicy`), names ours |
| Rule order | state (read) → policies in list order → value construction (`createPeriod`) | library |
| Domain errors | `Data.TaggedError` with rich context (ids, state, dates); no failure events; never sent to clients | ours |
| Time | `DateTime.Utc` everywhere except Prisma rows; `now` from `DateTime.now` in the use case (`TestClock` in tests); `Utc`, not `Zoned`, until a rule depends on local calendar days | ours |
| Repository | Narrowing finds + three writes (`insertAbsence`, `updateAbsence`, `deleteAbsence`) that store the state `evolveAbsence` produced, guarded by `before.updatedAt`. The repository never sees an event | Dudycz (decide / evolve), Spring Data (store the aggregate) |
| Event publishing order | The use case publishes after the write: find → decide → evolve → save → publish. Not atomic | ours |
| Atomic events | Opt-in per use case; here only archive. Write + `DomainEventOutbox.addDomainEvent` inside `Transactions.runInTransaction`; the outbox write requires `Transaction`, so it can't run outside one | ours |
| Identity | Hybrid: the client may send an `AbsenceId` (prefixed cuid2, format owned by the domain); otherwise the create use case calls `generateAbsenceId()`. A taken id is a create that lost a race → `AbsenceChangedConcurrentlyError` | ours |
| Tenancy | Every command, read, and write scoped by `OrganizationId`. The assignee must be a member of the organization: checked on create and reassign | Vernon (`TenantId`) |
| Events | Past tense + `Event` suffix; carry `occurredOn` | Vernon (past tense), ours (suffix) |
| Event publishing | `DomainEvents` port only; delivery belongs to the host | ours |
| Use cases | One `Context.Service` per command: `ArchiveAbsenceService.archiveAbsence(command)`; command in the same file | Vernon's flows, sliced |
| Commands | Input of the use case method only; plain readonly types; never passed into the model | library (`PlaceOnHoldCommand`) |
| Reads | `AbsenceViews` port returning `AbsenceView`; bypasses the model and the repository. Every method requires an `AbsenceVisibility`, the read rule as data: views filter, never reject, and never see an actor | library (`PatronProfiles`), Vernon (`*QueryService`) |
| API responses | `AbsenceView` is the response schema. Commands answer with the view (read after write); delete answers 204 | ours |
| HTTP errors | Every domain error has an HTTP variant (`AbsenceNotFoundHttpError`, …) with a status and a default actionable `message`; no codes. The controller maps 1:1 with `absenceHttpErrorFromAbsenceError`. Retry handling is an edge decision (`catchTag`), never a softened domain error | ours |
| Tag dispatch | `Match.valueTags` by default. `matchTag` (`lib/match-tag.ts`) when the result type follows the input's tag: the domain error's HTTP variant. No casts | ours |
| Organization | Routes carry `:organizationId`. A group middleware checks membership (`OrganizationMembers`) and provides `CurrentActor`; non-members never reach a handler | ours |
| Permissions | Always the actor model, no permission gates. `absenceActorFromPermissions` (the only reader of the keys) turns permissions into `AbsenceActor` flags; a policy or the visibility rule decides. The domain never sees a permission key. Own absences and create need no permission | elternportal (`lib/policies`), kgrzybek (`…OnlyByAuthorOrGroupOrganizerRule`), Vernon (`CollaboratorService.moderatorFrom`) |

---

## 2. Lifecycle and rules

```text
            activate               archive
  ┌───────┐ ───────▶ ┌────────┐ ───────▶ ┌──────────┐
  │ Draft │          │ Active │          │ Archived │
  └───────┘          └────────┘          └──────────┘
   │  ▲ reschedule    │  ▲ reschedule
   │  └ reassign      │  └ reassign
   └─ delete ─▶ gone  └─ delete ─▶ gone
```

| Command | Draft | Active | Archived |
|---|---|---|---|
| reschedule | ✓ within 1h of creation | ✓ within 1h of creation | `AbsenceAlreadyArchivedError` |
| reassign | ✓ within 1h of creation | ✓ within 1h of creation | `AbsenceAlreadyArchivedError` |
| activate | ✓ → Active | `AbsenceAlreadyActiveError` | `AbsenceAlreadyArchivedError` |
| archive | `AbsenceStillDraftError` | ✓ → Archived, unless ongoing → `AbsenceOngoingError` | `AbsenceAlreadyArchivedError` |
| delete | ✓ → gone | ✓ → gone | `AbsenceAlreadyArchivedError` |

Who may act, per ✓ cell:

| Command | Own absence | Someone else's draft | Someone else's active absence |
|---|---|---|---|
| reschedule, reassign, archive | ✓ | `NotAllowedToEditAbsenceError` | ✓ with `absences:update`, else `NotAllowedToEditAbsenceError` |
| delete | ✓ | `NotAllowedToDeleteAbsenceError` | ✓ with `absences:delete`, else `NotAllowedToDeleteAbsenceError` |
| activate | ✓ | `NotAbsenceCreatorError` | — (only drafts can be activated) |

- Create: any member of the organization, no permission.
- Create and reassign, about the new assignee: not a member of the organization → `AssigneeNotInOrganizationError`. Neither the actor nor related to the actor, without `absences:update` → `NotAllowedToAssignAbsenceError`. This applies to permitted editors too: editing someone else's absence doesn't mean handing it to anyone.
- Create and reschedule: `from >= to` → `InvalidPeriodError`.
- Reschedule and reassign: more than one hour after creation → `AbsenceEditWindowClosedError`. Applies to everyone, permitted users included.
- Drafts are visible only to their creator (§8), and only the creator can act on them.

Who sees what: reads filter, they never reject.

| Reader | Sees |
|---|---|
| has `absences:read` or `absences:update` | every absence in the organization, except others' drafts |
| otherwise | absences they created, absences assigned to them, and absences assigned to users they're related to, except others' drafts |
| the system (job, listener) | everything, stated explicitly (`AllAbsences`) |

- `getAbsenceById` of an absence the reader can't see → `AbsenceNotFoundError` (404). It doesn't reveal that the absence exists.
- `listAbsences` narrows: `?assigneeId=` for an unrelated user is `[]`, not 403.

Order for commands: the state check (in the read), then the who-acts policy, then the other policies. A user who may not act and sends a command for an absence in the wrong state gets 409, not 403. Accepted for now (§13).

---

## 3. Layout

```text
src/
├─ api.ts                               the host's root HttpApi; each module adds its group
├─ app.ts                               AbsenceHttpLayer: controller + services + adapters
├─ lib/
│  ├─ prefixed-id.ts                    prefixedId(prefix), createPrefixedId(prefix)
│  ├─ with-optional-tag.ts              decode-only variant of a TaggedStruct whose input may omit _tag
│  ├─ match-tag.ts                      matchTag, MemberWithTag: tag dispatch whose result follows the tag
│  ├─ date-time-utc-from-date.ts        Date → DateTime.Utc, null stays null
│  ├─ auth-middleware.ts                stand-in for the host's auth: provides CurrentUser
│  ├─ prisma-transactions.ts            stand-in for the host's PrismaTransactions, PrismaDomainEventOutbox
│  └─ organization-member-middleware.ts :organizationId → membership check → CurrentActor
├─ shared/                              ports and types owned elsewhere
│  ├─ ids.ts                            OrganizationId, UserId
│  ├─ current-user.ts                   CurrentUser, CurrentActor, Permissions
│  ├─ domain-events.ts                  DomainEvents.publishDomainEvent, DomainEventOutbox.addDomainEvent
│  ├─ transaction.ts                    Transaction, Transactions.runInTransaction
│  ├─ organization-members.ts           OrganizationMembers.isOrganizationMember
│  └─ user-relationships.ts             UserRelationships.listRelatedUserIds
└─ absence/
   ├─ domain/
   │  ├─ absence-id.ts                  AbsenceId, generateAbsenceId
   │  ├─ absence.ts                     states, transition inputs, transitions
   │  ├─ period.ts                      Period, createPeriod, isPeriodOngoingAt
   │  ├─ absence-actor.ts               AbsenceActor, AbsenceReader, AbsenceVisibility, absenceVisibilityFromReader
   │  ├─ absence-policy.ts              policies, per-transition lists, checkPolicies
   │  ├─ absence-event.ts               AbsenceDraftedEvent … AbsenceDeletedEvent, AbsenceEvent
   │  ├─ absence-error.ts               domain errors, AbsenceError
   │  └─ absence-repository.ts          port
   ├─ application/                      one <verb>-absence-service.ts per command
   ├─ view/absence-views.ts             port + AbsenceView
   ├─ infrastructure/
   │  ├─ prisma-absence-repository.ts
   │  ├─ prisma-absence-views.ts
   │  └─ absence-permissions.ts         AbsencePermission keys + absenceActorFromPermissions
   └─ http/
      ├─ absence-api.ts                 HttpApiGroup: endpoints, declared HTTP errors
      ├─ absence-http-errors.ts         one HTTP variant per domain error + absenceHttpErrorFromAbsenceError
      └─ absence-controller.ts          HttpApiBuilder.group: endpoint → use case / view
```

Files a host already has (auth, the root API, `shared/`) are stand-ins: map them to the host's.

---

## 4. Model (`absence/domain/*`)

Pure: no services, no I/O.

### Ids

The domain owns the id format: prefix + cuid2, not a UUID. `AbsenceId` gets its own file: events need it, and `absence.ts` imports the events, so one file would be an import cycle.

```ts
// lib/prefixed-id.ts
export const prefixedId = (prefix: string) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(new RegExp(`^${prefix}_[a-z][a-z0-9]{23}$`))))

export const createPrefixedId = (prefix: string): string => `${prefix}_${createId()}`
```

```ts
// absence/domain/absence-id.ts
export const AbsenceId = prefixedId("abs").pipe(Schema.brand("AbsenceId"))
export type AbsenceId = typeof AbsenceId.Type

// make checks the pattern, so a wrong prefix throws on the first call.
export const generateAbsenceId = (): AbsenceId => AbsenceId.make(createPrefixedId("abs"))
```

The caller brands: `Schema.brand` needs a literal, so a helper with a generic brand parameter doesn't compile. Ids of other modules are referenced, never redefined:

```ts
// shared/ids.ts
export const OrganizationId = Schema.String.pipe(Schema.brand("OrganizationId"))
export type OrganizationId = typeof OrganizationId.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
```

### States

Each state holds exactly the fields it guarantees. `ActiveAbsence.activatedAt` is not optional.

```ts
// absence/domain/absence.ts
const absenceFields = {
  absenceId: AbsenceId, organizationId: OrganizationId, creatorId: UserId, assigneeId: UserId,
  period: Period, createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,   // the instant of the last event; the repository guards on it
}

export const DraftAbsence = Schema.TaggedStruct("DraftAbsence", { ...absenceFields })
export type DraftAbsence = typeof DraftAbsence.Type

export const ActiveAbsence = Schema.TaggedStruct("ActiveAbsence", { ...absenceFields, activatedAt: Schema.DateTimeUtc })
export type ActiveAbsence = typeof ActiveAbsence.Type

export const ArchivedAbsence = Schema.TaggedStruct("ArchivedAbsence", {
  ...absenceFields, activatedAt: Schema.DateTimeUtc, archivedAt: Schema.DateTimeUtc,
})
export type ArchivedAbsence = typeof ArchivedAbsence.Type

export type Absence = DraftAbsence | ActiveAbsence | ArchivedAbsence   // nothing decodes to it
export type EditableAbsence = DraftAbsence | ActiveAbsence
```

`EditableAbsence` is named after what it allows: the states reschedule, reassign, and delete accept.

### Period

A constructor returns a `Result`; a question about the value is a plain function.

```ts
// absence/domain/period.ts
export const Period = Schema.Struct({ from: Schema.DateTimeUtc, to: Schema.DateTimeUtc })
export type Period = typeof Period.Type

export const createPeriod = ({ from, to }: { readonly from: DateTime.Utc; readonly to: DateTime.Utc }): Result.Result<Period, InvalidPeriodError> =>
  DateTime.isLessThan(from, to) ? Result.succeed({ from, to }) : Result.fail(new InvalidPeriodError({ from, to }))

// from <= now < to. Not DateTime.between: it includes both ends.
export const isPeriodOngoingAt = ({ period, now }: { readonly period: Period; readonly now: DateTime.Utc }): boolean =>
  DateTime.isGreaterThanOrEqualTo(now, period.from) && DateTime.isLessThan(now, period.to)
```

### Actor and visibility

```ts
// absence/domain/absence-actor.ts
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
```

- The flags name capabilities. School managers typically hold them, but they are granted per person, so no role name fits. The domain defines what a flag allows; it doesn't know which permission sets it (§11).
- No flag says "InOrganization": the permission adapter computes every flag for the route's organization, and every find and view is scoped to it.
- `relatedUserIds` serves both sides: the visibility rule filters by it, `assigneeMustBeSelfOrRelatedPolicy` checks the assignee against it. The controller loads it once per request; use cases never call `UserRelationships`.
- Writes take the actor; reads take a visibility. A read without a user states its visibility (`AllAbsences()`) instead of faking an actor with every flag set.
- `AbsenceVisibility` is `Data.TaggedEnum`, not a schema: it is never decoded or encoded.

| Situation | Pick |
|---|---|
| Reads and writes use the same principal and the same loaded facts | reader derived from the actor (`Pick<AbsenceActor, …>`) |
| A read-only user principal (support "view as", another module) | build an `AbsenceReader` |
| A reader that isn't a user (a feed token scoped to one assignee) | a new visibility variant (`AssigneeAbsences { assigneeId }`) |
| Reads need different facts than writes | a separate reader type |

### Transition inputs

One named input type per transition. The transition and its policies take the same type.

```ts
// absence/domain/absence.ts
export type CreateAbsenceInput = {
  readonly absenceId: AbsenceId; readonly organizationId: OrganizationId; readonly actor: AbsenceActor
  readonly assigneeId: UserId; readonly assigneeIsOrganizationMember: boolean
  readonly from: DateTime.Utc; readonly to: DateTime.Utc; readonly now: DateTime.Utc
}
…
export type ReassignAbsenceInput = {
  readonly absence: EditableAbsence; readonly actor: AbsenceActor
  readonly assigneeId: UserId; readonly assigneeIsOrganizationMember: boolean; readonly now: DateTime.Utc
}
export type ActivateAbsenceInput = { readonly absence: DraftAbsence; readonly actor: AbsenceActor; readonly now: DateTime.Utc }
export type ArchiveAbsenceInput = { readonly absence: ActiveAbsence; readonly actor: AbsenceActor; readonly now: DateTime.Utc }
export type DeleteAbsenceInput = { readonly absence: EditableAbsence; readonly actor: AbsenceActor; readonly now: DateTime.Utc }
```

- `assigneeIsOrganizationMember` is a fact loaded by the use case. It is required, so a use case that doesn't load it doesn't compile. It is about the assignee, not the actor, so it can't live on `AbsenceActor`.
- Create takes an `AbsenceActor`: creating needs no permission, but assigning anyone (`mayAssignAnyone`) does.

### Transitions

The `absence` field's type is the state that allows the transition: passing a `DraftAbsence` to `archiveAbsence` doesn't compile. Each transition exists once; Draft and Active share it through `EditableAbsence` until they diverge.

Every transition has the same shape: policies in list order, then value construction, then the event.

```ts
// absence/domain/absence.ts
export const createAbsence = (input: CreateAbsenceInput): Result.Result<
  AbsenceDraftedEvent, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError
> => Result.gen(function* () {
  yield* checkPolicies(createAbsencePolicies, input)
  const period = yield* createPeriod({ from: input.from, to: input.to })
  return AbsenceDraftedEvent.make({
    absenceId: input.absenceId, organizationId: input.organizationId, actorId: input.actor.userId, occurredOn: input.now,
    creatorId: input.actor.userId, assigneeId: input.assigneeId, period,
  })
})
…
export const archiveAbsence = (input: ArchiveAbsenceInput): Result.Result<
  AbsenceArchivedEvent, NotAllowedToEditAbsenceError | AbsenceOngoingError
> => Result.gen(function* () {
  yield* checkPolicies(archiveAbsencePolicies, input)
  return AbsenceArchivedEvent.make({
    absenceId: input.absence.absenceId, organizationId: input.absence.organizationId, actorId: input.actor.userId,
    occurredOn: input.now,
  })
})
```

All six signatures:

```text
createAbsence(input: CreateAbsenceInput)
  : Result<AbsenceDraftedEvent, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError>
rescheduleAbsence(input: RescheduleAbsenceInput)
  : Result<AbsenceRescheduledEvent, NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError | InvalidPeriodError>
reassignAbsence(input: ReassignAbsenceInput)
  : Result<AbsenceReassignedEvent, NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError>
activateAbsence(input: ActivateAbsenceInput)
  : Result<AbsenceActivatedEvent, NotAbsenceCreatorError>
archiveAbsence(input: ArchiveAbsenceInput)
  : Result<AbsenceArchivedEvent, NotAllowedToEditAbsenceError | AbsenceOngoingError>
deleteAbsence(input: DeleteAbsenceInput)
  : Result<AbsenceDeletedEvent, NotAllowedToDeleteAbsenceError>
```

### Where rules live

| Kind | Example | Place |
|---|---|---|
| Organization membership | the actor is a member of the route's organization | `OrganizationMemberMiddleware`, before any handler (§11). Not in the domain |
| Permission that changes a rule | may edit someone else's active absence; may assign anyone | `absenceActorFromPermissions` sets a flag (§11); a policy decides |
| Visibility | sees absences they're involved in; with `absences:read`, all | `absenceVisibilityFromReader` chooses; the views adapter translates it into a `where` (§8) |
| State | archived can't be edited | the narrowing find; the input's `absence` type accepts only allowed states |
| Who acts | the creator, or a permitted user on an active absence | first policy in the transition's list |
| Time or context | edit window; not archived while ongoing | a policy in the transition's list |
| Value invariant | `from < to` | value constructor (`createPeriod`) |
| Facts about the actor (I/O) | users the actor is related to | loaded once by the controller onto the actor (`relatedUserIds`) |
| Facts about the target (I/O) | assignee is a member of the organization | loaded by the use case into a required input field (`assigneeIsOrganizationMember`) |

### Policies (`absence/domain/absence-policy.ts`)

A policy is one rule of a transition: a pure function over the transition's input that succeeds or fails with a typed error. Each transition runs an ordered list; the list order decides which rejection is reported.

```ts
// absence/domain/absence-policy.ts
// The first rejection wins.
export const checkPolicies = <Input, E>(
  policies: ReadonlyArray<(input: Input) => Result.Result<void, E>>,
  input: Input,
): Result.Result<void, E> => {
  for (const policy of policies) {
    const policyResult = policy(input)
    if (Result.isFailure(policyResult)) return policyResult
  }
  return Result.succeed(undefined)
}

const isActingUser = (input: { readonly actor: AbsenceActor; readonly userId: UserId }) => input.userId === input.actor.userId
const isAbsenceCreator = (input: { readonly absence: Absence; readonly actor: AbsenceActor }) =>
  isActingUser({ actor: input.actor, userId: input.absence.creatorId })
…
export const onlyCreatorOrPermittedCanEditPolicy = (input: { readonly absence: EditableAbsence; readonly actor: AbsenceActor }) => {
  const notAllowedToEditAbsence = () => Result.fail(new NotAllowedToEditAbsenceError({
    absenceId: input.absence.absenceId, actorId: input.actor.userId, absenceState: input.absence._tag,
  }))
  return Match.valueTags(input.absence, {
    DraftAbsence: () => isAbsenceCreator(input) ? Result.succeed(undefined) : notAllowedToEditAbsence(),
    ActiveAbsence: () => isAbsenceCreator(input) || input.actor.mayEditOthersAbsences ? Result.succeed(undefined) : notAllowedToEditAbsence(),
  })
}
…
// A shared policy takes a subset of every input that lists it.
export const assigneeMustBeInOrganizationPolicy = (input: { readonly assigneeId: UserId; readonly assigneeIsOrganizationMember: boolean }) =>
  input.assigneeIsOrganizationMember
    ? Result.succeed(undefined)
    : Result.fail(new AssigneeNotInOrganizationError({ assigneeId: input.assigneeId }))

export const assigneeMustBeSelfOrRelatedPolicy = (input: { readonly actor: AbsenceActor; readonly assigneeId: UserId }) =>
  input.actor.mayAssignAnyone
    || isActingUser({ actor: input.actor, userId: input.assigneeId })
    || isRelatedToActor({ actor: input.actor, userId: input.assigneeId })
    ? Result.succeed(undefined)
    : Result.fail(new NotAllowedToAssignAbsenceError({ actorId: input.actor.userId, assigneeId: input.assigneeId }))

// one function for the instant the policy checks and the error reports
export const absenceEditableUntil = (absence: EditableAbsence): DateTime.Utc => DateTime.add(absence.createdAt, { hours: 1 })

export const editOnlyInFirstHourPolicy = (input: { readonly absence: EditableAbsence; readonly now: DateTime.Utc }) =>
  DateTime.isLessThanOrEqualTo(input.now, absenceEditableUntil(input.absence))
    ? Result.succeed(undefined)
    : Result.fail(new AbsenceEditWindowClosedError({
      absenceId: input.absence.absenceId, createdAt: input.absence.createdAt, editableUntil: absenceEditableUntil(input.absence),
    }))

// Per transition: a policy type and an ordered list. The order decides which rejection is reported.
…
export type ReassignAbsencePolicy = (input: ReassignAbsenceInput) => Result.Result<
  void, NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError
>
export const reassignAbsencePolicies: ReadonlyArray<ReassignAbsencePolicy> = [
  onlyCreatorOrPermittedCanEditPolicy, // may I touch this absence?
  assigneeMustBeInOrganizationPolicy,  // is the new assignee in the organization?
  assigneeMustBeSelfOrRelatedPolicy,   // may I give it to them?
  editOnlyInFirstHourPolicy,
]
…
export type ArchiveAbsencePolicy = (input: ArchiveAbsenceInput) => Result.Result<void, NotAllowedToEditAbsenceError | AbsenceOngoingError>
export const cannotArchiveWhileOngoingPolicy: ArchiveAbsencePolicy = (input) =>
  isPeriodOngoingAt({ period: input.absence.period, now: input.now })
    ? Result.fail(new AbsenceOngoingError({ absenceId: input.absence.absenceId, period: input.absence.period }))
    : Result.succeed(undefined)
export const archiveAbsencePolicies: ReadonlyArray<ArchiveAbsencePolicy> = [
  onlyCreatorOrPermittedCanEditPolicy,
  cannotArchiveWhileOngoingPolicy,
]
```

Names per transition share its prefix, so grepping `ArchiveAbsence` finds the whole slice:

| Slot | Name pattern | Example |
|---|---|---|
| Input | `<Transition>AbsenceInput` | `ArchiveAbsenceInput` |
| Policy type | `<Transition>AbsencePolicy` | `ArchiveAbsencePolicy` |
| Ordered list | `<transition>AbsencePolicies` | `archiveAbsencePolicies` |
| Single policy | the rule as a short sentence + `Policy`, without the subject. "Permitted" means the actor holds the flag | `cannotArchiveWhileOngoingPolicy` |

| Transition | Allowed in | Policies (in order) | Also |
|---|---|---|---|
| create | — | assignee in organization, may assign | `createPeriod` |
| reschedule | Draft, Active | creator or permitted editor, edit window | `createPeriod` |
| reassign | Draft, Active | creator or permitted editor, assignee in organization, may assign, edit window | — |
| activate | Draft | creator | — |
| archive | Active | creator or permitted editor, not ongoing | — |
| delete | Draft, Active | creator or permitted deleter | — |

- "Permitted" only ever applies to active absences; drafts belong to their creator.
- The edit and delete actor policies branch on state because the rule differs between Draft and Active while the input type accepts both. `Match.valueTags` is exhaustive: a new state in `EditableAbsence` doesn't compile until it has an actor rule.
- No `anyPolicy` combinator: `||` over named predicates says "creator or permitted" without picking which rejection to report.
- Shared policies return a narrower `Result` than the list's policy type; they are assignable to it, so they need no annotation.
- One list per transition, even when two are identical today (reschedule and reassign share their first and last policy), so they can diverge without a rename.
- A new rule is one function added to one list, plus its error in the policy type and the transition's signature.

---

## 5. Events (`absence/domain/absence-event.ts`)

```ts
// absence/domain/absence-event.ts
// Never imports absence.ts: absence.ts imports this file to build events.
const absenceEventFields = { absenceId: AbsenceId, organizationId: OrganizationId, actorId: UserId, occurredOn: Schema.DateTimeUtc }

export const AbsenceDraftedEvent = Schema.TaggedStruct("AbsenceDraftedEvent", {
  ...absenceEventFields, creatorId: UserId, assigneeId: UserId, period: Period, // occurredOn becomes createdAt
})
export type AbsenceDraftedEvent = typeof AbsenceDraftedEvent.Type
…
export const AbsenceEvent = Schema.Union([
  AbsenceDraftedEvent, AbsenceRescheduledEvent, AbsenceReassignedEvent,
  AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDeletedEvent,
])
export type AbsenceEvent = typeof AbsenceEvent.Type
```

| Event | Extra fields | Emitted by |
|---|---|---|
| `AbsenceDraftedEvent` | `creatorId`, `assigneeId`, `period` | `createAbsence` |
| `AbsenceRescheduledEvent` | `period`, `previousPeriod` | `rescheduleAbsence` |
| `AbsenceReassignedEvent` | `assigneeId`, `previousAssigneeId` | `reassignAbsence` |
| `AbsenceActivatedEvent` | — | `activateAbsence` |
| `AbsenceArchivedEvent` | — | `archiveAbsence` |
| `AbsenceDeletedEvent` | `assigneeId`, `period` (subscribers can still act on a gone absence) | `deleteAbsence` |

Built with `X.make({...})`. Anything that serialises events encodes through `AbsenceEvent`, never `JSON.stringify`.

### Evolve

A transition decides; `evolve` applies. Each event brings an absence into existence, changes it, or removes it:

```ts
// absence/domain/absence-event.ts
// Exclude puts a new event under change until this file names it a creation or a deletion.
export type AbsenceCreationEvent = AbsenceDraftedEvent
export type AbsenceDeletionEvent = AbsenceDeletedEvent
export type AbsenceChangeEvent = Exclude<AbsenceEvent, AbsenceCreationEvent | AbsenceDeletionEvent>
```

```ts
// absence/domain/absence.ts
export const initialAbsence = (event: AbsenceCreationEvent): Absence =>
  DraftAbsence.make({
    absenceId: event.absenceId, organizationId: event.organizationId, creatorId: event.creatorId,
    assigneeId: event.assigneeId, period: event.period, createdAt: event.occurredOn, updatedAt: event.occurredOn,
  })

export type EvolveAbsenceInput = { readonly absence: Absence; readonly event: AbsenceChangeEvent }
export const evolveAbsence = ({ absence, event }: EvolveAbsenceInput): Absence =>
  Match.valueTags(event, {
    AbsenceRescheduledEvent: (event) => ({ ...absence, period: event.period, updatedAt: event.occurredOn }),
    AbsenceReassignedEvent: (event) => ({ ...absence, assigneeId: event.assigneeId, updatedAt: event.occurredOn }),
    AbsenceActivatedEvent: (event) => ActiveAbsence.make({ ...absenceFieldsOf(absence), activatedAt: event.occurredOn, updatedAt: event.occurredOn }),
…
  })
```

- `evolve` is the one statement of what an event means for the state; no SQL restates it.
- It trusts the transition and never fails: an `AbsenceArchivedEvent` on a non-active absence is a defect upstream and leaves it unchanged.
- Every branch sets `updatedAt: event.occurredOn`, so the state after `evolve` is exactly the row the repository stores.
- A deletion has no state after it: the use case hands `deleteAbsence` the state before it.

---

## 6. Domain errors (`absence/domain/absence-error.ts`)

`Data.TaggedError` each, with the context a trace needs. Not schemas: an endpoint can only declare schema errors, so returning a domain error to a client doesn't compile.

```ts
// absence/domain/absence-error.ts
// raised by the finds (and AbsenceViews.getAbsenceById)
export class AbsenceNotFoundError extends Data.TaggedError("AbsenceNotFoundError")<{ readonly absenceId: AbsenceId }> {}
…
export class NotAllowedToEditAbsenceError extends Data.TaggedError("NotAllowedToEditAbsenceError")<{
  readonly absenceId: AbsenceId; readonly actorId: UserId; readonly absenceState: EditableAbsence["_tag"]
}> {}
…
export class AbsenceEditWindowClosedError extends Data.TaggedError("AbsenceEditWindowClosedError")<{
  readonly absenceId: AbsenceId; readonly createdAt: DateTime.Utc; readonly editableUntil: DateTime.Utc
}> {}
```

| Error | Fields | Raised by |
|---|---|---|
| `AbsenceNotFoundError` | `absenceId` | every find: no row in the organization. `AbsenceViews.getAbsenceById`: also when not visible |
| `AbsenceStillDraftError` | `absenceId` | `findActiveAbsenceById` |
| `AbsenceAlreadyActiveError` | `absenceId` | `findDraftAbsenceById` |
| `AbsenceAlreadyArchivedError` | `absenceId` | every find |
| `NotAbsenceCreatorError` | `absenceId`, `actorId` | `onlyCreatorCanActivatePolicy` |
| `NotAllowedToEditAbsenceError` | `absenceId`, `actorId`, `absenceState` | `onlyCreatorOrPermittedCanEditPolicy` |
| `NotAllowedToDeleteAbsenceError` | `absenceId`, `actorId`, `absenceState` | `onlyCreatorOrPermittedCanDeletePolicy` |
| `AssigneeNotInOrganizationError` | `assigneeId` | `assigneeMustBeInOrganizationPolicy` |
| `NotAllowedToAssignAbsenceError` | `actorId`, `assigneeId` | `assigneeMustBeSelfOrRelatedPolicy` |
| `AbsenceEditWindowClosedError` | `absenceId`, `createdAt`, `editableUntil` | `editOnlyInFirstHourPolicy` |
| `AbsenceOngoingError` | `absenceId`, `period` | `cannotArchiveWhileOngoingPolicy` |
| `InvalidPeriodError` | `from`, `to` | `createPeriod` |
| `AbsenceChangedConcurrentlyError` | `absenceId` | every write: another write came first (a taken id on insert, no row matching the guard on update or delete) |

- State errors name the actual state relative to the one-way lifecycle: *still* = not far enough, *already* = past it. A find raises them without knowing the command, and they read right for every command.
- `absenceState` is the state's tag (`"DraftAbsence" | "ActiveAbsence"`), the only states an actor policy sees.
- `AbsenceChangedConcurrentlyError` is expected, not a defect: two requests can act on the same absence between find and write. The client recovers by reloading, so it is typed (409).
- `AbsenceError`, the union of all thirteen, exists only for the exhaustive HTTP mapper (§11), never in a signature.

---

## 7. Ports

The repository port belongs to the domain; ports owned by other modules sit in `shared/`.

```ts
// absence/domain/absence-repository.ts
export type FindAbsenceByIdInput = { readonly organizationId: OrganizationId; readonly absenceId: AbsenceId }

// One write per kind of event, with the states it needs: a create has no state before, a delete none after.
export type InsertAbsenceInput = { readonly after: Absence }
export type UpdateAbsenceInput = { readonly before: Absence; readonly after: Absence }
export type DeleteAbsenceInput = { readonly before: Absence }

export class AbsenceRepository extends Context.Service<AbsenceRepository, {
  findDraftAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<DraftAbsence, AbsenceNotFoundError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError>
  findActiveAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<ActiveAbsence, AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError>
  findEditableAbsenceById(input: FindAbsenceByIdInput):
    Effect.Effect<EditableAbsence, AbsenceNotFoundError | AbsenceAlreadyArchivedError>
  insertAbsence(input: InsertAbsenceInput): Effect.Effect<void, AbsenceChangedConcurrentlyError>
  updateAbsence(input: UpdateAbsenceInput): Effect.Effect<void, AbsenceChangedConcurrentlyError>
  deleteAbsence(input: DeleteAbsenceInput): Effect.Effect<void, AbsenceChangedConcurrentlyError>
}>()("AbsenceRepository") {}
```

Three writes, ever: a new event or transition adds nothing here. Each fails only when another write came first, and the client recovers the same way (reload).

```ts
// shared/domain-events.ts
// Delivery belongs to the host (outbox, bus); this module only publishes.
export class DomainEvents extends Context.Service<DomainEvents, {
  publishDomainEvent(event: DomainEvent): Effect.Effect<void>
}>()("DomainEvents") {}

// Opt-in, for an event that must never be lost: the event becomes an outbox row in the write's transaction.
// The host's relay delivers the rows.
export class DomainEventOutbox extends Context.Service<DomainEventOutbox, {
  addDomainEvent(event: DomainEvent): Effect.Effect<void, never, Transaction>
}>()("DomainEventOutbox") {}
```

```ts
// shared/transaction.ts
// Proof that an effect runs inside a database transaction. Only runInTransaction provides it.
export class Transaction extends Context.Service<Transaction, {}>()("Transaction") {}

// Owned by the host: it opens the transaction its adapters share.
export class Transactions extends Context.Service<Transactions, {
  // Commits when the effect succeeds, rolls back when it fails.
  runInTransaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Transaction>>
}>()("Transactions") {}
```

- `Transaction` is on the outbox only. The repository writes don't require it: they join a transaction when one is open, so the five use cases that don't opt in stay as they are.

```ts
// shared/organization-members.ts
export class OrganizationMembers extends Context.Service<OrganizationMembers, {
  isOrganizationMember(input: { readonly organizationId: OrganizationId; readonly userId: UserId }): Effect.Effect<boolean>
}>()("OrganizationMembers") {}
```

```ts
// shared/user-relationships.ts
export class UserRelationships extends Context.Service<UserRelationships, {
  // e.g. guardian of, class teacher of; never contains userId
  listRelatedUserIds(input: { readonly organizationId: OrganizationId; readonly userId: UserId }): Effect.Effect<ReadonlySet<UserId>>
}>()("UserRelationships") {}
```

No port declares an infrastructure error: a failing database or service dies (§10).

---

## 8. Reads (`absence/view/absence-views.ts`)

The views port is a query: no model, no repository, no use case. `get*` / `list*` are views; `find*` is the repository, so grepping `AbsenceById` finds both sides.

```ts
// absence/view/absence-views.ts
// Also the API response schema. No organizationId: every request is scoped to one.
export const AbsenceView = Schema.Struct({
  absenceId: AbsenceId,
  creatorId: UserId,
  assigneeId: UserId,
  from: Schema.DateTimeUtc,
  to: Schema.DateTimeUtc,
  status: Schema.Literals(["draft", "active", "archived"]),
  createdAt: Schema.DateTimeUtc,
  activatedAt: Schema.NullOr(Schema.DateTimeUtc),
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
})
export type AbsenceView = typeof AbsenceView.Type

// Absent filter = no condition. Named for the reader, not for a column: the adapter maps each one.
export type AbsenceListFilters = { readonly assigneeId?: UserId; readonly creatorId?: UserId }

export class AbsenceViews extends Context.Service<AbsenceViews, {
  // not visible = not found
  getAbsenceById(input: {
    readonly organizationId: OrganizationId; readonly visibility: AbsenceVisibility; readonly absenceId: AbsenceId
  }): Effect.Effect<AbsenceView, AbsenceNotFoundError>
  // filters combine with AND, then visibility
  listAbsences(input: {
    readonly organizationId: OrganizationId; readonly visibility: AbsenceVisibility; readonly filters: AbsenceListFilters
  }): Effect.Effect<ReadonlyArray<AbsenceView>>
}>()("AbsenceViews") {}
```

- Every method requires a visibility, so no read skips the read rule, including a command's read-back.
- Split off a separate response type + one mapping function only when a second consumer reads the view or the API needs a versioned contract.

The adapter translates the visibility into a Prisma `where`, used by every query:

```ts
// absence/infrastructure/prisma-absence-views.ts
// Only translates the visibility; absenceVisibilityFromReader and system callers choose it.
const nonDraftOrCreatedByWhere = (userId: UserId): Prisma.AbsenceWhereInput =>
  ({ OR: [{ status: { not: "draft" } }, { creatorId: userId }] })

const absenceWhereFromFilters = ({ assigneeId, creatorId }: AbsenceListFilters): Prisma.AbsenceWhereInput => ({
  AND: [
    assigneeId === undefined ? {} : { assigneeId },
    creatorId === undefined ? {} : { creatorId },
  ],
})

const absenceWhereFromVisibility = (visibility: AbsenceVisibility): Prisma.AbsenceWhereInput =>
  AbsenceVisibility.$match(visibility, {
    AllAbsences: () => ({}),
    OrganizationAbsences: ({ userId }) => nonDraftOrCreatedByWhere(userId),
    InvolvedAbsences: ({ userId, relatedUserIds }) => ({
      AND: [
        nonDraftOrCreatedByWhere(userId),
        { OR: [{ creatorId: userId }, { assigneeId: userId }, { assigneeId: { in: [...relatedUserIds] } }] },
      ],
    }),
  })
…
    getAbsenceById: Effect.fn("PrismaAbsenceViews.getAbsenceById")(function* ({ organizationId, visibility, absenceId }) {
      // Not visible = no row = AbsenceNotFoundError; any other Prisma error dies.
      const row = yield* prisma.absence.findUniqueOrThrow({
        where: { id: absenceId, organizationId, AND: [absenceWhereFromVisibility(visibility)] },
        select: absenceViewSelect,
      }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceNotFoundError({ absenceId }),
          (error) => Effect.die(error),
        ),
      )
      return yield* decodeAbsenceView(row)
    }),
```

- Rows are reshaped (`id → absenceId`, `Date → dateTimeUtcFromDate`) and decoded with `Schema.decodeEffect(AbsenceView)`; a row that doesn't decode dies.
- Filters are `Schema.optionalKey` from the query to the port: an absent filter is a missing key. The adapter maps each filter to its condition in `absenceWhereFromFilters`, like the visibility: port names never reach Prisma unmapped.

---

## 9. Use cases (`absence/application/*`)

### Commands

| Library command | Keep? |
|---|---|
| One named input per intent, built by the controller | Yes. It is the object argument of the use case method |
| Same input from any entry point (controller, listener, job) | Yes |
| Converts raw input to a domain value (`getHoldDuration()` → `HoldDuration`) | No. HttpApi decodes to branded ids and `DateTime.Utc`s; `createPeriod` runs in the model |
| Carries `timestamp` (`Instant.now()` at the edge) | No. The use case reads `DateTime.now`, so tests use `TestClock` |
| Never passed into the aggregate | Yes. The use case builds the transition input from the command, the loaded absence, and `now` |

A plain readonly type per use case. Use a `Schema.Struct` only when a command crosses a process boundary (queue, persisted job, audit log). A use case returns `void` or the new id; read shapes never enter the write side.

### Template

Every command use case is the same five steps: find the narrowed absence, call its transition, `evolve` the event onto it, save, publish the event. The write follows the event's kind: a create calls `insertAbsence({ after: initialAbsence(event) })`, a change `updateAbsence({ before, after: evolveAbsence(…) })`, a delete `deleteAbsence({ before })`. Publish comes after the write, so a failed write publishes nothing.

```ts
// absence/application/activate-absence-service.ts
export type ActivateAbsenceCommand = { readonly organizationId: OrganizationId; readonly actor: AbsenceActor; readonly absenceId: AbsenceId }

export class ActivateAbsenceService extends Context.Service<ActivateAbsenceService, {
  activateAbsence(command: ActivateAbsenceCommand): Effect.Effect<void,
    | AbsenceNotFoundError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError
    | NotAbsenceCreatorError
    | AbsenceChangedConcurrentlyError>
}>()("ActivateAbsenceService") {
  static layer = Layer.effect(ActivateAbsenceService, Effect.gen(function* () {
    const absenceRepository = yield* AbsenceRepository
    const domainEvents = yield* DomainEvents
    return ActivateAbsenceService.of({
      activateAbsence: Effect.fn("ActivateAbsenceService.activateAbsence")(function* ({ organizationId, actor, absenceId }) {
        const now = yield* DateTime.now
        const absence = yield* absenceRepository.findDraftAbsenceById({ organizationId, absenceId })
        const event = yield* Effect.fromResult(activateAbsence({ absence, actor, now }))
        yield* absenceRepository.updateAbsence({ before: absence, after: evolveAbsence({ absence, event }) })
        yield* domainEvents.publishDomainEvent(event)
      }),
    })
  }))
}
```

- The error union lists the find's errors, then the transition's, then the write's. The compiler checks it against the body.
- The method key `activateAbsence` doesn't shadow the imported domain function. Grep `ActivateAbsenceService` for the use case, `activateAbsence(` for both.
- `Effect.fn("ActivateAbsenceService.activateAbsence")` is the span: it records the domain error with its context before the controller maps it.

Archive opts in to atomic events: the save and the publish run in one transaction, and the publish is an outbox row.

```ts
// absence/application/archive-absence-service.ts
    const domainEventOutbox = yield* DomainEventOutbox
    const transactions = yield* Transactions
…
        // atomic: the archive and its event commit together, or neither does
        yield* absenceRepository.updateAbsence({ before: absence, after: evolveAbsence({ absence, event }) }).pipe(
          Effect.andThen(domainEventOutbox.addDomainEvent(event)),
          transactions.runInTransaction,
        )
```

- Without `runInTransaction` the body requires `Transaction`, and the service doesn't compile.
- The error union is unchanged: a domain error inside the transaction rolls it back and comes out typed.

Create and reassign also load a fact about the new assignee:

```ts
// absence/application/create-absence-service.ts
export type CreateAbsenceCommand = {
  readonly organizationId: OrganizationId
  readonly actor: AbsenceActor
  readonly absenceId?: AbsenceId | undefined   // client-sent (optimistic UI, idempotent retry); else generated
  readonly assigneeId: UserId
  readonly from: DateTime.Utc
  readonly to: DateTime.Utc
}
…
      createAbsence: Effect.fn("CreateAbsenceService.createAbsence")(function* ({ organizationId, actor, absenceId: requestedAbsenceId, assigneeId, from, to }) {
        const now = yield* DateTime.now
        const absenceId = requestedAbsenceId ?? generateAbsenceId()
        // loaded every time, even when the actor may assign anyone: skipping it would move the rule here
        const assigneeIsOrganizationMember = yield* organizationMembers.isOrganizationMember({ organizationId, userId: assigneeId })
        const event = yield* Effect.fromResult(createAbsence({ absenceId, organizationId, actor, assigneeId, assigneeIsOrganizationMember, from, to, now }))
        yield* absenceRepository.insertAbsence({ after: initialAbsence(event) })
        yield* domainEvents.publishDomainEvent(event)
        return absenceId
      }),
```

### Call trees

```text
CreateAbsenceService.createAbsence({ organizationId, actor, absenceId?, assigneeId, from, to })
  : Effect<AbsenceId, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError | AbsenceChangedConcurrentlyError>
├─ absenceId ?? generateAbsenceId(): AbsenceId
├─ OrganizationMembers.isOrganizationMember({ organizationId, userId: assigneeId })
│    : Effect<boolean>   → assigneeIsOrganizationMember
├─ createAbsence({ absenceId, organizationId, actor, assigneeId, assigneeIsOrganizationMember, from, to, now })
│    : Result<AbsenceDraftedEvent, AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | InvalidPeriodError>
│  ├─ checkPolicies(createAbsencePolicies, input)
│  └─ createPeriod({ from, to })
├─ initialAbsence(event): Absence
├─ AbsenceRepository.insertAbsence({ after })
│    : Effect<void, AbsenceChangedConcurrentlyError>
└─ DomainEvents.publishDomainEvent(event): Effect<void>

RescheduleAbsenceService.rescheduleAbsence({ organizationId, actor, absenceId, from, to })
├─ AbsenceRepository.findEditableAbsenceById({ organizationId, absenceId })
│    : Effect<EditableAbsence, AbsenceNotFoundError | AbsenceAlreadyArchivedError>
├─ rescheduleAbsence({ absence, actor, from, to, now })
│    : Result<AbsenceRescheduledEvent, NotAllowedToEditAbsenceError | AbsenceEditWindowClosedError | InvalidPeriodError>
│  ├─ checkPolicies(rescheduleAbsencePolicies, input)
│  └─ createPeriod({ from, to })
├─ evolveAbsence({ absence, event }): Absence
├─ AbsenceRepository.updateAbsence({ before, after })
│    : Effect<void, AbsenceChangedConcurrentlyError>
└─ DomainEvents.publishDomainEvent(event): Effect<void>

ReassignAbsenceService.reassignAbsence({ organizationId, actor, absenceId, assigneeId })
├─ AbsenceRepository.findEditableAbsenceById({ organizationId, absenceId })
│    : Effect<EditableAbsence, AbsenceNotFoundError | AbsenceAlreadyArchivedError>
├─ OrganizationMembers.isOrganizationMember({ organizationId, userId: assigneeId })
│    : Effect<boolean>   → assigneeIsOrganizationMember (after the find: a missing absence is 404 first)
├─ reassignAbsence({ absence, actor, assigneeId, assigneeIsOrganizationMember, now })
│    : Result<AbsenceReassignedEvent, NotAllowedToEditAbsenceError | AssigneeNotInOrganizationError | NotAllowedToAssignAbsenceError | AbsenceEditWindowClosedError>
│  └─ checkPolicies(reassignAbsencePolicies, input)
├─ evolveAbsence({ absence, event }): Absence
├─ AbsenceRepository.updateAbsence({ before, after })
│    : Effect<void, AbsenceChangedConcurrentlyError>
└─ DomainEvents.publishDomainEvent(event): Effect<void>

ActivateAbsenceService.activateAbsence({ organizationId, actor, absenceId })
├─ AbsenceRepository.findDraftAbsenceById({ organizationId, absenceId })
│    : Effect<DraftAbsence, AbsenceNotFoundError | AbsenceAlreadyActiveError | AbsenceAlreadyArchivedError>
├─ activateAbsence({ absence, actor, now })
│    : Result<AbsenceActivatedEvent, NotAbsenceCreatorError>
├─ evolveAbsence({ absence, event }): Absence
├─ AbsenceRepository.updateAbsence({ before, after })
│    : Effect<void, AbsenceChangedConcurrentlyError>
└─ DomainEvents.publishDomainEvent(event): Effect<void>

ArchiveAbsenceService.archiveAbsence({ organizationId, actor, absenceId })
├─ AbsenceRepository.findActiveAbsenceById({ organizationId, absenceId })
│    : Effect<ActiveAbsence, AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError>
├─ archiveAbsence({ absence, actor, now })
│    : Result<AbsenceArchivedEvent, NotAllowedToEditAbsenceError | AbsenceOngoingError>
├─ evolveAbsence({ absence, event }): Absence
└─ Transactions.runInTransaction(…)            one commit
   ├─ AbsenceRepository.updateAbsence({ before, after })
   │    : Effect<void, AbsenceChangedConcurrentlyError>
   └─ DomainEventOutbox.addDomainEvent(event): Effect<void, never, Transaction>

DeleteAbsenceService.deleteAbsence({ organizationId, actor, absenceId })
├─ AbsenceRepository.findEditableAbsenceById({ organizationId, absenceId })
│    : Effect<EditableAbsence, AbsenceNotFoundError | AbsenceAlreadyArchivedError>
├─ deleteAbsence({ absence, actor, now })
│    : Result<AbsenceDeletedEvent, NotAllowedToDeleteAbsenceError>
├─ AbsenceRepository.deleteAbsence({ before })
│    : Effect<void, AbsenceChangedConcurrentlyError>
└─ DomainEvents.publishDomainEvent(event): Effect<void>
```

Every transition call is wrapped in `Effect.fromResult(…)` in the code.

---

## 10. Repository (`absence/infrastructure/prisma-absence-repository.ts`)

### Table

```prisma
// prisma/schema.prisma
enum AbsenceStatus {
  draft
  active
  archived
}

model Absence {
  id             String        @id // AbsenceId
  organizationId String
  creatorId      String
  assigneeId     String
  from           DateTime
  to             DateTime
  status         AbsenceStatus
  createdAt      DateTime // AbsenceDraftedEvent.occurredOn; no @default
  updatedAt      DateTime // the last event's occurredOn; the write guard. No @updatedAt
  activatedAt    DateTime?
  archivedAt     DateTime?

  @@index([organizationId, assigneeId])
  @@index([organizationId, creatorId])
}
```

`status` is a Prisma enum, so Prisma types it as `"draft" | "active" | "archived"` and every match on it is exhaustive.

### Rows → domain

Each find checks the row's `status` first, then decodes only the state it returns. Nothing decodes the full union.

| Check | Failure | Kind |
|---|---|---|
| No row in the organization | `AbsenceNotFoundError` | expected: the client sent a wrong or foreign id |
| `status` not allowed by this find | the error named after the actual state | expected: the client acted on the wrong state |
| Row with an allowed `status` doesn't decode (e.g. `active` with a null `activatedAt`, a bad id) | die | corrupt data: no caller can recover |
| Unknown `status` | die | `Match.exhaustive` throws |

No row schemas. Prisma's `select` types the row; the repository reshapes it into the domain shape and decodes with the domain schema, which checks what Prisma's types don't (non-null `activatedAt`, brands, the id pattern). Writes go the other way, state → row (`absenceRowFromState`, below).

```ts
// lib/with-optional-tag.ts
// Same schema, but decoding input may omit `_tag`; the schema's own tag fills it in. Decode only.
// Struct.assign, not `({ ...fields, _tag })`: with generic Fields the spread types the decoded _tag as never.
export const withOptionalTag = <Tag extends SchemaAST.LiteralValue, Fields extends Schema.Struct.Fields>(
  schema: Schema.TaggedStruct<Tag, Fields>,
) => schema.mapFields(Struct.assign({ _tag: Schema.tagDefaultOmit(schema.fields._tag.schema.literal) }))
```

```ts
// lib/date-time-utc-from-date.ts
// null stays null; the return type follows the input.
export const dateTimeUtcFromDate = <D extends Date | null>(date: D): D extends Date ? DateTime.Utc : null =>
  (date === null ? null : DateTime.fromDateUnsafe(date)) as D extends Date ? DateTime.Utc : null
```

```ts
// absence/infrastructure/prisma-absence-repository.ts
// No archivedAt: no find returns an archived absence.
const absenceSelect = {
  id: true, organizationId: true, creatorId: true, assigneeId: true,
  from: true, to: true, status: true, createdAt: true, updatedAt: true, activatedAt: true,
} satisfies Prisma.AbsenceSelect

type AbsenceRow = Prisma.AbsenceGetPayload<{ select: typeof absenceSelect }>

const DraftAbsenceFromFields = withOptionalTag(DraftAbsence)
const ActiveAbsenceFromFields = withOptionalTag(ActiveAbsence).mapFields((fields) => ({
  ...fields,
  // the column is nullable, the state isn't: a null fails the decode
  activatedAt: Schema.NullOr(Schema.DateTimeUtc).pipe(Schema.refine(Predicate.isNotNull)),
}))

const absenceFieldsFromRow = (row: AbsenceRow) => ({
  absenceId: row.id,
  organizationId: row.organizationId,
  creatorId: row.creatorId,
  assigneeId: row.assigneeId,
  period: { from: dateTimeUtcFromDate(row.from), to: dateTimeUtcFromDate(row.to) },
  createdAt: dateTimeUtcFromDate(row.createdAt),
  updatedAt: dateTimeUtcFromDate(row.updatedAt),
})

// A row that doesn't decode is corrupt: die.
const decodeDraftAbsence = (row: AbsenceRow) =>
  Schema.decodeEffect(DraftAbsenceFromFields)(absenceFieldsFromRow(row)).pipe(Effect.orDie)

const decodeActiveAbsence = (row: AbsenceRow) =>
  Schema.decodeEffect(ActiveAbsenceFromFields)({
    ...absenceFieldsFromRow(row),
    activatedAt: dateTimeUtcFromDate(row.activatedAt),
  }).pipe(Effect.orDie)
```

- `…FromFields` marks the decode-only schemas; `DraftAbsence` stays the schema for everything else. `tagDefaultOmit` also drops `_tag` when encoding, which is why they are decode-only.
- `Schema.decodeEffect`, not `decodeUnknownEffect`: its input is typed as the schema's `Encoded`, so a reshape that misses or mistypes a field is a compile error. The decode still checks brands and the id pattern at runtime.
- A column the state requires but the row allows to be null: `NullOr(…).pipe(Schema.refine(Predicate.isNotNull))`. No branch before the decode.

### Finds

```ts
// absence/infrastructure/prisma-absence-repository.ts
  // No row in the organization is the expected failure; any other Prisma error dies. An unknown status makes Match.exhaustive throw: a defect.
…
  const findActiveAbsenceById = Effect.fn("PrismaAbsenceRepository.findActiveAbsenceById")(
    function* ({ organizationId, absenceId }: FindAbsenceByIdInput) {
      const row = yield* prisma.absence.findUniqueOrThrow({ where: { id: absenceId, organizationId }, select: absenceSelect }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceNotFoundError({ absenceId }),
          (error) => Effect.die(error),
        ),
      )
      return yield* Match.value(row.status).pipe(
        Match.when("draft", () => new AbsenceStillDraftError({ absenceId })),
        Match.when("active", () => decodeActiveAbsence(row)),
        Match.when("archived", () => new AbsenceAlreadyArchivedError({ absenceId })),
        Match.exhaustive,
      )
    },
  )
  // …one per find, as in the table
```

| Find | `"draft"` | `"active"` | `"archived"` |
|---|---|---|---|
| `findDraftAbsenceById` | `decodeDraftAbsence` | `AbsenceAlreadyActiveError` | `AbsenceAlreadyArchivedError` |
| `findActiveAbsenceById` | `AbsenceStillDraftError` | `decodeActiveAbsence` | `AbsenceAlreadyArchivedError` |
| `findEditableAbsenceById` | `decodeDraftAbsence` | `decodeActiveAbsence` | `AbsenceAlreadyArchivedError` |

`findUniqueOrThrow` takes `organizationId` next to the unique `id` (Prisma allows extra filters in a unique `where`), so another organization's absence is `AbsenceNotFoundError`. No `decodeArchivedAbsence`: no find returns an archived absence.

### Writes

```text
PrismaAbsenceRepository.updateAbsence({ before, after })
└─ prisma.absence.update({ where: absenceGuard(before), data: absenceRowFromState(after) })
   └─ PrismaRecordNotFoundError → AbsenceChangedConcurrentlyError
```

| Write | Prisma | Expected error → domain error |
|---|---|---|
| `insertAbsence({ after })` | `create { absenceRowFromState(after) }` | `PrismaUniqueConstraintError` (P2002, `id` is the only unique constraint) → `AbsenceChangedConcurrentlyError` |
| `updateAbsence({ before, after })` | `update { where: absenceGuard(before), data: absenceRowFromState(after) }` | `PrismaRecordNotFoundError` (P2025) → `AbsenceChangedConcurrentlyError` |
| `deleteAbsence({ before })` | `delete { where: absenceGuard(before) }` | `PrismaRecordNotFoundError` (P2025) → `AbsenceChangedConcurrentlyError` |

Every other Prisma error dies: the port declares no infrastructure errors.

```ts
// absence/infrastructure/prisma-absence-repository.ts
const absenceRowFromState = (absence: Absence): Prisma.AbsenceUncheckedCreateInput =>
  Match.valueTags(absence, {
    DraftAbsence: (absence) => ({ ...absenceColumnsFromFields(absence), status: AbsenceStatus.draft, activatedAt: null, archivedAt: null }),
…
  })

// the row the write must still find: before's identity and updatedAt
const absenceGuard = (before: Absence) =>
  ({ id: before.absenceId, organizationId: before.organizationId, updatedAt: DateTime.toDateUtc(before.updatedAt) })
…
  const updateAbsence = Effect.fn("PrismaAbsenceRepository.updateAbsence")(
    function* ({ before, after }: UpdateAbsenceInput) {
      yield* prisma.absence.update({ where: absenceGuard(before), data: absenceRowFromState(after), select: { id: true } }).pipe(
        Effect.catchTag(
          "PrismaRecordNotFoundError",
          () => new AbsenceChangedConcurrentlyError({ absenceId: before.absenceId }),
          (error) => Effect.die(error),
        ),
      )
    },
  )
```

- The guard is `before`'s identity and `updatedAt`: it catches every write between find and save, whatever field it touched.
- `AbsenceStatus.draft`, not `"draft"`: `Match.valueTags` infers each branch on its own, and a bare string literal widens to `string`.
- `Effect.catchTag(tag, f, orElse)`: the third argument handles every other error. Pass `(error) => Effect.die(error)`, not `Effect.die`: its `unknown` parameter makes TypeScript infer the error type as `unknown`, and the tag no longer type-checks.
- `update` / `delete` with the guard in `where` throw P2025 when nothing matches. Not `updateMany` + `count === 0`.
- Writes `select: { id: true }`: nothing is read back; the caller has `after`, the controller reads the view.
- Every `DateTime.Utc` is converted with `DateTime.toDateUtc`.
- Cost: `updatedAt` has millisecond precision, so two writes of one row within the same millisecond could pass each other's guard.

### Transactions and outbox (`lib/prisma-transactions.ts`)

```prisma
// prisma/schema.prisma
// Written by DomainEventOutbox in the transaction of the write; the host's relay delivers and deletes the rows.
model OutboxEvent {
  id         Int      @id @default(autoincrement()) // delivery order
  eventTag   String
  payload    String   // JSON text, encoded through DomainEvent
  occurredOn DateTime
}
```

```ts
// lib/prisma-transactions.ts
// Every PrismaService call inside the effect joins the transaction: the generated client reads it from the context.
// Sandboxed: the generated $transaction rethrows Cause.squash, which turns a defect into a typed failure. The whole
// cause passes through instead; anything else it throws (the commit failed) dies.
export const PrismaTransactions = Layer.effect(Transactions, Effect.gen(function* () {
  const prisma = yield* PrismaService
  return Transactions.of({
    runInTransaction: (effect) =>
      prisma.$transaction(effect.pipe(Effect.provideService(Transaction, Transaction.of({})), Effect.sandbox)).pipe(
        Effect.catch((cause) => Cause.isCause(cause) ? Effect.failCause(cause) : Effect.die(cause)),
      ),
  })
}))
…
      yield* Transaction // outside a transaction the row could commit without the write: doesn't compile
```

- `Transaction` carries nothing: `effect-prisma-generator` already passes the transaction client through the context (`PrismaTransactionClientService`), so `PrismaAbsenceRepository` is unchanged.
- `payload` is `String`, not `Json`: Prisma's `Json` input type excludes a top-level `null`, and the encoded event's type includes it.
- The host owns both adapters, as it owns `DomainEvents`; they sit in `lib/` beside the auth middleware.

`matchTag` is the one helper for tag dispatch whose result type follows the tag:

```ts
// lib/match-tag.ts
type Tagged = { readonly _tag: string }

export type MemberWithTag<U extends Tagged, Tag extends U["_tag"]> = Extract<U, { readonly _tag: Tag }>

type HandlersByTag<U extends Tagged, Out> = { readonly [Tag in keyof Out]: (value: MemberWithTag<U, Tag & U["_tag"]>) => Out[Tag] }

export const matchTag = <U extends Tagged>() =>
  <Out extends { readonly [Tag in U["_tag"]]: unknown }>(
    handlers: HandlersByTag<U, Out> & { readonly [Tag in Exclude<keyof Out, U["_tag"]>]: never },
  ) => {
    // Indexing the mapped type with a generic Tag keeps value and result correlated (TypeScript #47109).
    const handlerByTag: HandlersByTag<U, Out> = handlers
    return <Tag extends U["_tag"]>(value: MemberWithTag<U, Tag>): Out[Tag] => handlerByTag[value._tag](value)
  }
```

- `matchTag<U>()(handlers)`: one handler per tag of `U`. The result is `<Tag>(value: MemberWithTag<U, Tag>) => Out[Tag]`. `Out` is inferred from the handlers unless given.
- Give `Out` when a declared type already fixes the result. Otherwise infer it, as the HTTP mapper does (§11).
- `Out extends` rejects a missing tag; the `never` part rejects an unknown one.
- Curried, because TypeScript can't take `U` explicitly and infer `Out` in the same call.
- Not `Match.valueTags`: it returns the union of every branch's result, which a generic signature only accepts with a cast. `Match.valueTags` stays the default when the union is fine (the policies, §4; `evolveAbsence`, §5).

---

## 11. HTTP (`absence/http/*`)

### Organization (`lib/organization-member-middleware.ts`)

Clients send the organization in the route (`/organizations/:organizationId/absences`), so one API serves every organization the user belongs to:
- `AuthMiddleware` (the host's) provides `CurrentUser { userId, permissions }` from the session.
- `OrganizationMemberMiddleware` checks membership and provides `CurrentActor { userId, organizationId, permissions }`. Non-members never reach a handler.
- Handlers read `currentActor.organizationId`. Clients never send `actorId` or capabilities.

```ts
// lib/organization-member-middleware.ts
export class NotOrganizationMemberHttpError extends Schema.TaggedError<NotOrganizationMemberHttpError>()("NotOrganizationMemberHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("You're not a member of this organization."))),
}, { httpApiStatus: 403 }) {}

// Shared by the middleware and every endpoint's params, so both decode the same key with the same schema.
export const OrganizationPathParams = Schema.Struct({ organizationId: OrganizationId })

export class OrganizationMemberMiddleware extends HttpApiMiddleware.Service<OrganizationMemberMiddleware, {
  requires: CurrentUser
  provides: CurrentActor
}>()("OrganizationMemberMiddleware", { error: NotOrganizationMemberHttpError }) {
  static layer = Layer.effect(OrganizationMemberMiddleware, Effect.gen(function* () {
    const organizationMembers = yield* OrganizationMembers
    return OrganizationMemberMiddleware.of(Effect.fnUntraced(function* (handler) {
      // The endpoint's params are decoded inside `handler`, so the middleware decodes the route params itself.
      const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPathParams).pipe(Effect.orDie)
      const currentUser = yield* CurrentUser
      if (!(yield* organizationMembers.isOrganizationMember({ organizationId, userId: currentUser.userId }))) {
        return yield* new NotOrganizationMemberHttpError()
      }
      return yield* handler.pipe(Effect.provideService(CurrentActor, { userId: currentUser.userId, permissions: currentUser.permissions, organizationId }))
    }))
  }))
}
```

`NotOrganizationMemberHttpError` is the one HTTP error not derived from a domain error: it is about access to an organization, and every module shares it.

### Permissions (`absence/infrastructure/absence-permissions.ts`)

Every permission goes through the actor model: the adapter turns it into an `AbsenceActor` flag, and a policy or the visibility rule decides. There are no permission gates. All three permissions here combine with data ("creator OR permission", "related to the assignee"); a gate would turn that into "creator AND permission".

```ts
// absence/infrastructure/absence-permissions.ts
// The absence module owns its keys. This file is the only code that reads them.
export const AbsencePermission = Schema.Literals(["absences:read", "absences:update", "absences:delete"])
export type AbsencePermission = typeof AbsencePermission.Type

// The caller loads relatedUserIds once per request.
export const absenceActorFromPermissions = ({ userId, organizationId, permissions, relatedUserIds }: {
  readonly userId: UserId
  readonly organizationId: OrganizationId
  readonly permissions: Permissions
  readonly relatedUserIds: ReadonlySet<UserId>
}): AbsenceActor => {
  const hasAbsencePermission = (permission: AbsencePermission) => permissions.hasPermission(permission, organizationId)
  return {
    userId,
    relatedUserIds,
    mayEditOthersAbsences: hasAbsencePermission("absences:update"),
    mayDeleteOthersAbsences: hasAbsencePermission("absences:delete"),
    mayAssignAnyone: hasAbsencePermission("absences:update"),
    mayReadOthersAbsences: hasAbsencePermission("absences:read") || hasAbsencePermission("absences:update"),   // edit implies read
  }
}
```

| Permission | Grants | Missing → |
|---|---|---|
| `absences:read` | see absences the reader isn't involved in | filtered out (404 on get, missing from lists) |
| `absences:update` | reschedule, reassign, archive someone else's **active** absence; assign anyone in the organization; what `absences:read` grants | `NotAllowedToEditAbsenceError`, `NotAllowedToAssignAbsenceError` |
| `absences:delete` | delete someone else's **active** absence | `NotAllowedToDeleteAbsenceError` |

- Create, activate, and anything on your own absence need no permission.
- Identity/access owns roles and role → permission. The absence module owns its keys and this adapter. A different permission system means a different adapter; flags, policies, and visibility stay.
- Jobs and listeners don't pass through HTTP. A deferred user command rebuilds the actor at run time with this adapter. A system intent (a nightly job archiving ended absences) is open (§13); never a user actor with every flag set.

### HTTP errors (`absence/http/absence-http-errors.ts`)

Domain errors carry internal context. Clients get the HTTP variant: the domain error's name + `Http`, a status, and a default actionable `message`. No codes: the `_tag` in the body identifies the error.

```ts
// absence/http/absence-http-errors.ts
export class AbsenceNotFoundHttpError extends Schema.TaggedError<AbsenceNotFoundHttpError>()("AbsenceNotFoundHttpError", {
  message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("This absence doesn't exist or isn't visible to you."))),
}, { httpApiStatus: 404 }) {}
…
export const absenceHttpErrorFromAbsenceError = matchTag<AbsenceError>()({
  AbsenceNotFoundError: () => new AbsenceNotFoundHttpError(),
…
})
```

- `matchTag` (§10) with `Out` inferred: one entry per domain error, each returning its HTTP variant.
- A handler ends with `Effect.mapError(absenceHttpErrorFromAbsenceError)`. Its errors infer `Tag` as the union of their tags, so its error type is exactly their variants, and the endpoint's `error: [...]` list is checked against it.
- Not `Match.valueTags`: it returns all 14 variants, and no endpoint that declares only its own would compile.
- `Schema.withConstructorDefault` takes an `Effect`, so the default is `Effect.succeed("…")`.
- Fields: `message` only. Add a field only when the client needs it to act (e.g. `editableUntil`), never internal ids or actor data.

| Domain error | Status | Default `message` |
|---|---|---|
| `AbsenceNotFoundError` | 404 | This absence doesn't exist or isn't visible to you. |
| `NotAbsenceCreatorError` | 403 | Only the creator of this absence can activate it. |
| `NotAllowedToEditAbsenceError` | 403 | Only the creator can change this absence. Once it's active, people with the absences:update permission can too. |
| `NotAllowedToDeleteAbsenceError` | 403 | Only the creator can delete this absence. Once it's active, people with the absences:delete permission can too. |
| `NotAllowedToAssignAbsenceError` | 403 | You can assign absences to yourself and to people you're responsible for. Assigning others needs the absences:update permission. |
| `AssigneeNotInOrganizationError` | 422 | The assignee isn't a member of this organization. |
| `InvalidPeriodError` | 422 | The start must be before the end. |
| `AbsenceStillDraftError` | 409 | This absence is still a draft. Activate it first. |
| `AbsenceAlreadyActiveError` | 409 | This absence is already active. |
| `AbsenceAlreadyArchivedError` | 409 | This absence is archived and can't be changed. |
| `AbsenceEditWindowClosedError` | 409 | Absences can only be edited within one hour of creation. |
| `AbsenceOngoingError` | 409 | This absence is in progress. Archive it after it ends. |
| `AbsenceChangedConcurrentlyError` | 409 | Someone else changed this absence. Reload and try again. |

### Endpoints (`absence/http/absence-api.ts`)

Paths are relative to the group prefix `/organizations/:organizationId`. Instants travel as ISO 8601 strings through `Schema.DateTimeUtc`'s JSON codec.

| Endpoint | Name | Success | HTTP errors, in check order (without the `HttpError` suffix) |
|---|---|---|---|
| `POST /absences` `{ absenceId?, assigneeId, from, to }` | `createAbsence` | 201 view | `AssigneeNotInOrganization`, `NotAllowedToAssignAbsence`, `InvalidPeriod`, `AbsenceChangedConcurrently` (taken id), `AbsenceNotFound` (read-back) |
| `PUT /absences/:absenceId/period` `{ from, to }` | `rescheduleAbsence` | 200 view | `AbsenceNotFound`, `AbsenceAlreadyArchived`, `NotAllowedToEditAbsence`, `AbsenceEditWindowClosed`, `InvalidPeriod`, `AbsenceChangedConcurrently` |
| `PUT /absences/:absenceId/assignee` `{ assigneeId }` | `reassignAbsence` | 200 view | `AbsenceNotFound`, `AbsenceAlreadyArchived`, `NotAllowedToEditAbsence`, `AssigneeNotInOrganization`, `NotAllowedToAssignAbsence`, `AbsenceEditWindowClosed`, `AbsenceChangedConcurrently` |
| `POST /absences/:absenceId/activate` | `activateAbsence` | 200 view | `AbsenceNotFound`, `AbsenceAlreadyActive`, `AbsenceAlreadyArchived`, `NotAbsenceCreator`, `AbsenceChangedConcurrently` |
| `POST /absences/:absenceId/archive` | `archiveAbsence` | 200 view | `AbsenceNotFound`, `AbsenceStillDraft`, `AbsenceAlreadyArchived`, `NotAllowedToEditAbsence`, `AbsenceOngoing`, `AbsenceChangedConcurrently` |
| `DELETE /absences/:absenceId` | `deleteAbsence` | 204 | `AbsenceNotFound`, `AbsenceAlreadyArchived`, `NotAllowedToDeleteAbsence`, `AbsenceChangedConcurrently` |
| `GET /absences/:absenceId` | `getAbsenceById` | 200 view | `AbsenceNotFound` |
| `GET /absences?assigneeId=&creatorId=` | `listAbsences` | 200 view[] | — |

Every endpoint also returns `NotAuthenticatedHttpError` (401, the host's) and `NotOrganizationMemberHttpError` (403) from the middleware.

```ts
// absence/http/absence-api.ts
const AbsencePathParams = Schema.Struct({ ...OrganizationPathParams.fields, absenceId: AbsenceId })

// Errors in check order: not found → wrong state → actor → policy / value → concurrency.
export class AbsenceApiGroup extends HttpApiGroup.make("absences")
  .add(
    HttpApiEndpoint.post("createAbsence", "/absences", {
      params: OrganizationPathParams,
      payload: Schema.Struct({
        absenceId: Schema.optional(AbsenceId),
        assigneeId: UserId,
        from: Schema.DateTimeUtc,
        to: Schema.DateTimeUtc,
      }),
      success: AbsenceView.pipe(HttpApiSchema.status(201)),
…
    HttpApiEndpoint.post("archiveAbsence", "/absences/:absenceId/archive", {
      params: AbsencePathParams,
      success: AbsenceView,
      error: [
        AbsenceNotFoundHttpError, AbsenceStillDraftHttpError, AbsenceAlreadyArchivedHttpError,
        NotAllowedToEditAbsenceHttpError, AbsenceOngoingHttpError, AbsenceChangedConcurrentlyHttpError,
      ],
    }),
…
    HttpApiEndpoint.get("listAbsences", "/absences", {
      params: OrganizationPathParams,
      query: { assigneeId: Schema.optionalKey(UserId), creatorId: Schema.optionalKey(UserId) },
      success: Schema.Array(AbsenceView),
    }),
  )
  // prefix and middleware apply only to endpoints added before them
  .prefix("/organizations/:organizationId")
  .middleware(OrganizationMemberMiddleware)
  .middleware(AuthMiddleware)
{}
```

- List filters are `query` params, not nested routes: they filter one collection and combine.
- The compiler checks each endpoint's `error` list against its handler: a handler that can fail with an undeclared HTTP error doesn't compile. That is how create's read-back `AbsenceNotFound` showed up.
- 201: `AbsenceView.pipe(HttpApiSchema.status(201))`; the handler returns the view as for every other command.

### Controller (`absence/http/absence-controller.ts`)

Commands answer with the view, read back with the actor's visibility. The absence is visible to whoever just changed it: the creator, or someone with `absences:update` (edit implies read). Delete reads nothing.

```text
AbsenceController.archiveAbsence({ params })
├─ CurrentActor                                         (from OrganizationMemberMiddleware)
├─ UserRelationships.listRelatedUserIds({ organizationId, userId })
│    : Effect<ReadonlySet<UserId>>   → relatedUserIds, once per request
├─ absenceActorFromPermissions({ userId, organizationId, permissions, relatedUserIds }): AbsenceActor
├─ absenceVisibilityFromReader(actor): AbsenceVisibility
├─ ArchiveAbsenceService.archiveAbsence({ organizationId, actor, absenceId })
│    : Effect<void, AbsenceNotFoundError | AbsenceStillDraftError | AbsenceAlreadyArchivedError
│                 | NotAllowedToEditAbsenceError | AbsenceOngoingError | AbsenceChangedConcurrentlyError>
├─ AbsenceViews.getAbsenceById({ organizationId, visibility, absenceId })
│    : Effect<AbsenceView, AbsenceNotFoundError>
└─ any domain error → absenceHttpErrorFromAbsenceError(error)
```

```ts
// absence/http/absence-controller.ts
export const AbsenceController = HttpApiBuilder.group(Api, "absences", Effect.fn(function* (handlers) {
  const createAbsenceService = yield* CreateAbsenceService
…
  const absenceViews = yield* AbsenceViews
  const userRelationships = yield* UserRelationships

  // Once per request: the actor for commands, and the visibility for reads.
  const loadAbsenceActorAndVisibility = Effect.gen(function* () {
    const currentActor = yield* CurrentActor
    const relatedUserIds = yield* userRelationships.listRelatedUserIds({
      organizationId: currentActor.organizationId, userId: currentActor.userId,
    })
    const actor = absenceActorFromPermissions({
      userId: currentActor.userId, organizationId: currentActor.organizationId, permissions: currentActor.permissions, relatedUserIds,
    })
    return { organizationId: currentActor.organizationId, actor, visibility: absenceVisibilityFromReader(actor) }
  })

  return handlers.handleAll({
    createAbsence: ({ payload }) => Effect.gen(function* () {
      const { organizationId, actor, visibility } = yield* loadAbsenceActorAndVisibility
      const absenceId = yield* createAbsenceService.createAbsence({
        organizationId, actor, absenceId: payload.absenceId, assigneeId: payload.assigneeId, from: payload.from, to: payload.to,
      })
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),
…
    archiveAbsence: ({ params }) => Effect.gen(function* () {
      const { organizationId, actor, visibility } = yield* loadAbsenceActorAndVisibility
      yield* archiveAbsenceService.archiveAbsence({ organizationId, actor, absenceId: params.absenceId })
      return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId: params.absenceId })
    }).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),
…
    listAbsences: ({ query }) => Effect.gen(function* () {
      const { organizationId, visibility } = yield* loadAbsenceActorAndVisibility
      return yield* absenceViews.listAbsences({ organizationId, visibility, filters: query })
    }),
  })
}))
```

### Retries

Retries and idempotency are decided here, per endpoint; the domain stays truthful (`AbsenceAlreadyArchivedError`, `AbsenceChangedConcurrentlyError`). The example code doesn't soften any endpoint. To make one retry-safe, catch the tag and answer as if it succeeded:

```ts
// not in the example code: an opt-in, retry-safe archive handler
archiveAbsence: ({ params }) => Effect.gen(function* () {
  const { organizationId, actor, visibility } = yield* loadAbsenceActorAndVisibility
  yield* archiveAbsenceService.archiveAbsence({ organizationId, actor, absenceId: params.absenceId }).pipe(
    Effect.catchTag("AbsenceAlreadyArchivedError", () => Effect.void),   // a retry of a finished archive: read back, 200
  )
  return yield* absenceViews.getAbsenceById({ organizationId, visibility, absenceId: params.absenceId })
}).pipe(Effect.mapError(absenceHttpErrorFromAbsenceError)),
```

A create retried with the same client-sent `absenceId` does the same with `AbsenceChangedConcurrentlyError`. The visibility then decides: the same creator gets the view, and an id that belongs to someone else's invisible absence gets 404 from the read-back.

---

## 12. Wiring and tests

```ts
// app.ts
// Requires from the host: PrismaService, DomainEvents, DomainEventOutbox, Transactions, OrganizationMembers, UserRelationships, AuthMiddleware.
export const AbsenceHttpLayer = AbsenceController.pipe(
  Layer.provide([
    CreateAbsenceService.layer, RescheduleAbsenceService.layer, ReassignAbsenceService.layer,
    ActivateAbsenceService.layer, ArchiveAbsenceService.layer, DeleteAbsenceService.layer,
  ]),
  Layer.provide([PrismaAbsenceRepository, PrismaAbsenceViews]),
  Layer.provideMerge(OrganizationMemberMiddleware.layer),
)
```

- No merged "all use cases" layer for other entry points: a listener or job provides only the service it uses.
- The middleware layer is `provideMerge`d: the HTTP router resolves it when it builds the routes.

Tests (`test/`), at the lowest place that owns each rule. Fixtures (`test/support.ts`) are the events that lead to a state, folded through `initialAbsence` and `evolveAbsence`. Each was checked by breaking its rule and watching it fail.

| Rule | Test |
|---|---|
| Actor policies: own / others' draft / others' active × flag | `absence-policy.test.ts`, table, plain values |
| Assignee policies: membership × self / related / unrelated × `mayAssignAnyone` | `absence-policy.test.ts`, through `checkPolicies(createAbsencePolicies, …)` |
| Edit window at exactly `absenceEditableUntil` and 1 ms after; ongoing at `from` and `to` | `absence-policy.test.ts` |
| List order decides the reported rejection | `absence-policy.test.ts` (reassign) |
| Permissions → flags, scoped to the organization | `absence-translations.test.ts` |
| Domain error → HTTP variant and status | `absence-translations.test.ts` |
| `matchTag` dispatch; result typed by tag; missing or unknown tag rejected (`@ts-expect-error`) | `match-tag.test.ts` |
| Finds let through only their states; foreign organization; corrupt row dies | `prisma-absence-repository.test.ts`, real Postgres |
| Writes: a taken id, a stale update, a stale delete → `AbsenceChangedConcurrentlyError` | `prisma-absence-repository.test.ts`, real Postgres |
| Atomic archive: both rows commit; a failed outbox write rolls the archive back and stays a defect; a domain error stays typed; an outbox write outside a transaction doesn't compile (`@ts-expect-error`) | `archive-absence-service.test.ts`, real Postgres |
| Visibility `where` per reader: own / others' draft / assigned / related / unrelated / other organization | `prisma-absence-views.test.ts`, real Postgres |
| The whole path: middleware, permissions, read-back, 201, error mapping, `TestClock` | `absence-http.test.ts`, `HttpApiTest` against the real handlers and Postgres |

No separate tests for transitions whose policies are tested, use cases that only find → decide → evolve → save → publish, or schemas: the types prove them.

---

## 13. Open

1. Write + publish are not atomic, except in archive: the other use cases publish after the write, so a crash in between loses the event. Each opts in as archive does once its events must not be lost.
2. Edit window for permitted users: it counts from creation, so they can only reschedule or reassign others' absences within that first hour. Archive and delete aren't windowed.
3. Commands vs visibility: a command on an absence the actor can't see answers 409 or 403, while a read answers 404. It reveals that an absence with a known id exists, and its state. To hide it, the finds would take the actor's visibility (not visible → `AbsenceNotFoundError`) before the state check.
4. System intents (a nightly job archiving ended absences): an actor-less transition with its own policy list, or an actor variant every policy handles. Decide with the first real case.
