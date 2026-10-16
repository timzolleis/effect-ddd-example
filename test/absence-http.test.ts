import { expect, layer } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { HttpClientRequest, HttpServer } from "effect/http"
import { HttpApiMiddleware, HttpApiTest } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api.ts"
import { AbsenceHttpLayer } from "../src/app.ts"
import { AuthMiddleware } from "../src/lib/auth-middleware.ts"
import type { UserId } from "../src/shared/ids.ts"
import {
  alice, at, AuthMiddlewareLayer, bob, child, host, HostLayer, manager, organizationId, outsider, PrismaLayer, resetDatabase,
  resetHost, unknownAbsenceId,
} from "./support.ts"

const TestLayer = Layer.mergeAll(
  AbsenceHttpLayer.pipe(Layer.provideMerge(AuthMiddlewareLayer)),
  HttpServer.layerServices,
).pipe(Layer.provide([PrismaLayer, HostLayer]))

// one typed client per user; the bearer token is the userId
const makeClientFor = (userId: UserId) => HttpApiTest.groups(Api, ["absences"]).pipe(Effect.provide(
  HttpApiMiddleware.layerClient(AuthMiddleware, ({ next, request }) => next(HttpClientRequest.bearerToken(request, userId))),
))
const setup = Effect.gen(function* () {
  yield* Effect.promise(() => resetDatabase())
  resetHost()
  yield* TestClock.setTime(DateTime.toEpochMillis(at("2026-02-01T10:00:00Z")))
  return {
    alice: (yield* makeClientFor(alice)).absences,
    bob: (yield* makeClientFor(bob)).absences,
    manager: (yield* makeClientFor(manager)).absences,
    outsider: (yield* makeClientFor(outsider)).absences,
  }
})
const errorTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.flip, Effect.map((error) => error._tag))

const params = { organizationId }
const period = { from: at("2026-03-01T00:00:00Z"), to: at("2026-03-02T00:00:00Z") }

layer(TestLayer)("absence HTTP", (it) => {
  it.effect("lifecycle: create → activate → reschedule → archive", () => Effect.gen(function* () {
    const client = yield* setup
    const created = yield* client.alice.createAbsence({ params, payload: { assigneeId: child, ...period } })
    expect(created).toMatchObject({ status: "draft", creatorId: alice, assigneeId: child })
    const absenceParams = { organizationId, absenceId: created.absenceId }

    // others can't see a draft: 404, not 403
    expect(yield* errorTag(client.bob.getAbsenceById({ params: absenceParams }))).toBe("AbsenceNotFoundHttpError")
    expect(yield* errorTag(client.bob.activateAbsence({ params: absenceParams }))).toBe("NotAbsenceCreatorHttpError")

    expect((yield* client.alice.activateAbsence({ params: absenceParams })).status).toBe("active")
    expect(yield* errorTag(client.alice.activateAbsence({ params: absenceParams }))).toBe("AbsenceAlreadyActiveHttpError")

    const rescheduled = yield* client.alice.rescheduleAbsence({
      params: absenceParams, payload: { from: at("2026-03-03T00:00:00Z"), to: at("2026-03-04T00:00:00Z") },
    })
    expect(DateTime.formatIso(rescheduled.from)).toBe("2026-03-03T00:00:00.000Z")
    expect(host.publishedEvents.map((event) => event._tag)).toEqual(["AbsenceDraftedEvent", "AbsenceActivatedEvent", "AbsenceRescheduledEvent"])

    yield* TestClock.setTime(DateTime.toEpochMillis(at("2026-03-03T12:00:00Z")))
    expect(yield* errorTag(client.alice.archiveAbsence({ params: absenceParams }))).toBe("AbsenceOngoingHttpError")
    expect(yield* errorTag(client.alice.rescheduleAbsence({ params: absenceParams, payload: period })))
      .toBe("AbsenceEditWindowClosedHttpError")

    yield* TestClock.setTime(DateTime.toEpochMillis(at("2026-03-04T00:00:00Z")))
    expect((yield* client.alice.archiveAbsence({ params: absenceParams })).status).toBe("archived")
    expect(yield* errorTag(client.alice.deleteAbsence({ params: absenceParams }))).toBe("AbsenceAlreadyArchivedHttpError")
  }))

  it.effect("permissions: absences:delete deletes someone else's active absence, not their draft", () => Effect.gen(function* () {
    const client = yield* setup
    host.permissions.set(manager, new Set([`${organizationId}:absences:delete`]))
    const draft = yield* client.alice.createAbsence({ params, payload: { assigneeId: alice, ...period } })
    const active = yield* client.alice.createAbsence({ params, payload: { assigneeId: alice, ...period } })
    yield* client.alice.activateAbsence({ params: { organizationId, absenceId: active.absenceId } })

    // the manager can't see alice's draft (no absences:read), so delete is 403 from the policy, read-back never happens
    expect(yield* errorTag(client.manager.deleteAbsence({ params: { organizationId, absenceId: draft.absenceId } })))
      .toBe("NotAllowedToDeleteAbsenceHttpError")
    yield* client.manager.deleteAbsence({ params: { organizationId, absenceId: active.absenceId } })
    expect(yield* errorTag(client.alice.getAbsenceById({ params: { organizationId, absenceId: active.absenceId } })))
      .toBe("AbsenceNotFoundHttpError")
  }))

  it.effect("assignee rules on create", () => Effect.gen(function* () {
    const client = yield* setup
    expect(yield* errorTag(client.alice.createAbsence({ params, payload: { assigneeId: bob, ...period } })))
      .toBe("NotAllowedToAssignAbsenceHttpError")
    expect(yield* errorTag(client.alice.createAbsence({ params, payload: { assigneeId: outsider, ...period } })))
      .toBe("AssigneeNotInOrganizationHttpError")
    expect(yield* errorTag(client.alice.createAbsence({ params, payload: { assigneeId: alice, from: period.to, to: period.from } })))
      .toBe("InvalidPeriodHttpError")
    host.permissions.set(manager, new Set([`${organizationId}:absences:update`]))
    const created = yield* client.manager.createAbsence({ params, payload: { assigneeId: bob, ...period } })
    expect(created.assigneeId).toBe(bob)
  }))

  it.effect("client-sent id: reused → AbsenceAlreadyExistsHttpError", () => Effect.gen(function* () {
    const client = yield* setup
    const absenceId = unknownAbsenceId
    yield* client.alice.createAbsence({ params, payload: { absenceId, assigneeId: alice, ...period } })
    expect(yield* errorTag(client.alice.createAbsence({ params, payload: { absenceId, assigneeId: alice, ...period } })))
      .toBe("AbsenceAlreadyExistsHttpError")
  }))

  it.effect("lists filter by visibility", () => Effect.gen(function* () {
    const client = yield* setup
    yield* client.alice.createAbsence({ params, payload: { assigneeId: child, ...period } })
    yield* client.bob.createAbsence({ params, payload: { assigneeId: bob, ...period } })
    expect((yield* client.alice.listAbsences({ params, query: {} })).map((absence) => absence.assigneeId)).toEqual([child])
    expect(yield* client.alice.listAbsences({ params, query: { assigneeId: bob } })).toEqual([])
  }))

  it.effect("non-members never reach a handler", () => Effect.gen(function* () {
    const client = yield* setup
    expect(yield* errorTag(client.outsider.listAbsences({ params, query: {} }))).toBe("NotOrganizationMemberHttpError")
  }))
})
