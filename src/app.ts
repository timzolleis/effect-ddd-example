import { Layer } from "effect"
import { ActivateAbsenceService } from "./absence/application/activate-absence-service.ts"
import { ArchiveAbsenceService } from "./absence/application/archive-absence-service.ts"
import { CreateAbsenceService } from "./absence/application/create-absence-service.ts"
import { ReassignAbsenceService } from "./absence/application/reassign-absence-service.ts"
import { RescheduleAbsenceService } from "./absence/application/reschedule-absence-service.ts"
import { WithdrawAbsenceService } from "./absence/application/withdraw-absence-service.ts"
import { AbsenceController } from "./absence/http/absence-controller.ts"
import { PrismaAbsenceRepository } from "./absence/infrastructure/prisma-absence-repository.ts"
import { PrismaAbsenceViews } from "./absence/infrastructure/prisma-absence-views.ts"
import { OrganizationMemberMiddleware } from "./lib/organization-member-middleware.ts"

// Requires from the host: PrismaService, DomainEvents, OrganizationMembers, UserRelationships, AuthMiddleware.
export const AbsenceHttpLayer = AbsenceController.pipe(
  Layer.provide([
    CreateAbsenceService.layer, RescheduleAbsenceService.layer, ReassignAbsenceService.layer,
    ActivateAbsenceService.layer, ArchiveAbsenceService.layer, WithdrawAbsenceService.layer,
  ]),
  Layer.provide([PrismaAbsenceRepository, PrismaAbsenceViews]),
  Layer.provideMerge(OrganizationMemberMiddleware.layer),
)
