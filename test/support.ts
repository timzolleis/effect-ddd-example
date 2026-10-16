import { PrismaPg } from "@prisma/adapter-pg"
import { DateTime, Effect, Layer, Redacted } from "effect"
import { PrismaClient } from "~prisma/client"
import { layerFromPrismaClient, PrismaService } from "~prisma/effect"
import type { AbsenceActor } from "../src/absence/domain/absence-actor.ts"
import { AbsenceId, generateAbsenceId } from "../src/absence/domain/absence-id.ts"
import type { ActiveAbsence, DraftAbsence } from "../src/absence/domain/absence.ts"
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

const absenceFieldsFor = (overrides: { creatorId?: UserId; assigneeId?: UserId; createdAt?: DateTime.Utc }) => ({
  absenceId: generateAbsenceId(), organizationId,
  creatorId: overrides.creatorId ?? alice, assigneeId: overrides.assigneeId ?? alice,
  period: { from: at("2026-03-01T00:00:00Z"), to: at("2026-03-02T00:00:00Z") },
  createdAt: overrides.createdAt ?? at("2026-02-01T10:00:00Z"),
})
export const makeDraftAbsence = (overrides: Parameters<typeof absenceFieldsFor>[0] = {}): DraftAbsence =>
  ({ _tag: "DraftAbsence", ...absenceFieldsFor(overrides) })
export const makeActiveAbsence = (overrides: Parameters<typeof absenceFieldsFor>[0] = {}): ActiveAbsence =>
  ({ _tag: "ActiveAbsence", ...absenceFieldsFor(overrides), activatedAt: at("2026-02-01T10:05:00Z") })

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
