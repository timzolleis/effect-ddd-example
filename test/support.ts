import { assert } from "@effect/vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { DateTime, Effect, Layer, Redacted } from "effect"
import { PrismaClient } from "~prisma/client"
import { layerFromPrismaClient, PrismaService } from "~prisma/effect"
import type { AbsenceActor } from "../src/absence/domain/absence-actor.ts"
import {
  AbsenceActivatedEvent, AbsenceArchivedEvent, AbsenceDraftedEvent, type AbsenceChangeEvent, type AbsenceCreationEvent,
} from "../src/absence/domain/absence-event.ts"
import { AbsenceId, generateAbsenceId } from "../src/absence/domain/absence-id.ts"
import {
  evolveAbsence, initialAbsence, type Absence, type ActiveAbsence, type ArchivedAbsence, type DraftAbsence,
} from "../src/absence/domain/absence.ts"
import { AuthMiddleware, NotAuthenticatedHttpError } from "../src/lib/auth-middleware.ts"
import { CurrentUser } from "../src/shared/current-user.ts"
import { DomainEvents, type DomainEvent } from "../src/shared/domain-events.ts"
import { OrganizationId, UserId } from "../src/shared/ids.ts"
import { OrganizationMembers } from "../src/shared/organization-members.ts"
import { UserRelationships } from "../src/shared/user-relationships.ts"

export const organizationId = OrganizationId.make("org_1")
export const otherOrganizationId = OrganizationId.make("org_2")
export const alice = UserId.make("alice")     // member, no permissions
export const bob = UserId.make("bob")         // member, no permissions
export const child = UserId.make("child")     // member, related to alice
export const manager = UserId.make("manager") // member, permissions per test
export const outsider = UserId.make("outsider")

export const at = (iso: string) => DateTime.makeUnsafe(iso)

export const makeActor = (overrides: Partial<AbsenceActor> & Pick<AbsenceActor, "userId">): AbsenceActor => ({
  mayEditOthersAbsences: false, mayDeleteOthersAbsences: false, mayAssignAnyone: false, mayReadOthersAbsences: false,
  relatedUserIds: new Set(), ...overrides,
})

// A fixture is the events that lead to its state, never a state written by hand.
const absenceAfter = (creation: AbsenceCreationEvent, ...changes: ReadonlyArray<AbsenceChangeEvent>): Absence =>
  changes.reduce((absence, event) => evolveAbsence({ absence, event }), initialAbsence(creation))

type AbsenceFixtureInput = { readonly creatorId?: UserId; readonly assigneeId?: UserId; readonly createdAt?: DateTime.Utc }

const makeDraftedEvent = ({ creatorId = alice, assigneeId = alice, createdAt = at("2026-02-01T10:00:00Z") }: AbsenceFixtureInput) =>
  AbsenceDraftedEvent.make({
    absenceId: generateAbsenceId(), organizationId, actorId: creatorId, occurredOn: createdAt, creatorId, assigneeId,
    period: { from: at("2026-03-01T00:00:00Z"), to: at("2026-03-02T00:00:00Z") },
  })
const makeActivatedEvent = (drafted: AbsenceDraftedEvent, occurredOn: DateTime.Utc) =>
  AbsenceActivatedEvent.make({ absenceId: drafted.absenceId, organizationId, actorId: drafted.creatorId, occurredOn })
const makeArchivedEvent = (drafted: AbsenceDraftedEvent, occurredOn: DateTime.Utc) =>
  AbsenceArchivedEvent.make({ absenceId: drafted.absenceId, organizationId, actorId: drafted.creatorId, occurredOn })

export const makeDraftAbsence = (input: AbsenceFixtureInput = {}): DraftAbsence => {
  const absence = absenceAfter(makeDraftedEvent(input))
  assert(absence._tag === "DraftAbsence")
  return absence
}
export const makeActiveAbsence = ({ activatedOn = at("2026-02-01T10:05:00Z"), ...input }: AbsenceFixtureInput & { readonly activatedOn?: DateTime.Utc } = {}): ActiveAbsence => {
  const drafted = makeDraftedEvent(input)
  const absence = absenceAfter(drafted, makeActivatedEvent(drafted, activatedOn))
  assert(absence._tag === "ActiveAbsence")
  return absence
}
export const makeArchivedAbsence = (input: AbsenceFixtureInput = {}): ArchivedAbsence => {
  const drafted = makeDraftedEvent(input)
  const absence = absenceAfter(drafted, makeActivatedEvent(drafted, at("2026-02-01T10:05:00Z")), makeArchivedEvent(drafted, at("2026-03-03T00:00:00Z")))
  assert(absence._tag === "ArchivedAbsence")
  return absence
}

export const unknownAbsenceId = AbsenceId.make("abs_zzzzzzzzzzzzzzzzzzzzzzzz")

// ── Host stand-ins, reset per test ──

export const host = {
  members: new Set<string>(),                       // `${organizationId}:${userId}`
  relatedUserIds: new Map<UserId, ReadonlySet<UserId>>(),
  permissions: new Map<UserId, ReadonlySet<string>>(), // `${organizationId}:${permission}`
  publishedEvents: [] as Array<DomainEvent>,
}
export const resetHost = () => {
  host.members = new Set([alice, bob, child, manager].map((userId) => `${organizationId}:${userId}`))
  host.relatedUserIds = new Map([[alice, new Set([child])]])
  host.permissions = new Map()
  host.publishedEvents = []
}

export const HostLayer = Layer.mergeAll(
  Layer.succeed(OrganizationMembers, OrganizationMembers.of({
    isOrganizationMember: ({ organizationId, userId }) => Effect.sync(() => host.members.has(`${organizationId}:${userId}`)),
  })),
  Layer.succeed(UserRelationships, UserRelationships.of({
    listRelatedUserIds: ({ userId }) => Effect.sync(() => host.relatedUserIds.get(userId) ?? new Set()),
  })),
  Layer.succeed(DomainEvents, DomainEvents.of({
    publishDomainEvent: (event) => Effect.sync(() => { host.publishedEvents.push(event) }),
  })),
)

// bearer token = userId
export const AuthMiddlewareLayer = Layer.succeed(AuthMiddleware, AuthMiddleware.of({
  bearer: (httpEffect, { credential }) => Effect.gen(function* () {
    const token = Redacted.value(credential)
    if (token === "") return yield* new NotAuthenticatedHttpError()
    const userId = UserId.make(token)
    return yield* httpEffect.pipe(Effect.provideService(CurrentUser, {
      userId,
      permissions: {
        hasPermission: (permission, organizationId) =>
          host.permissions.get(userId)?.has(`${organizationId}:${permission}`) ?? false,
      },
    }))
  }),
}))

// ── Real database ──

export const databaseUrl = process.env.DATABASE_URL ?? "postgresql://absence:absence@localhost:55432/absence"
export const prismaClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
export const PrismaLayer = PrismaService.layer.pipe(Layer.provide(layerFromPrismaClient(prismaClient)))
export const resetDatabase = () => prismaClient.absence.deleteMany()
