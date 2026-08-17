import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import type { Role } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';

/**
 * Journal d'audit, volontairement borné à quelques actions sensibles plutôt
 * qu'une trace générique de toute mutation : note modifiée/supprimée, élève
 * déplacé de classe, compte archivé/restauré/supprimé définitivement.
 */
export type AuditAction =
  | 'grade.updated'
  | 'grade.deleted'
  | 'student.moved'
  | 'account.archived'
  | 'account.restored'
  | 'account.permanently_deleted';

export interface RecordAuditInput {
  schoolId: number;
  actorUserId: number;
  action: AuditAction;
  targetType: string;
  targetId?: number | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort : un échec d'écriture du journal ne doit jamais faire échouer
 * l'action métier elle-même (modifier une note, déplacer un élève...). Une
 * erreur ici est tracée côté serveur, jamais renvoyée à l'appelant.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const actor = await prisma.user.findUnique({
      where: { id: input.actorUserId },
      select: { firstName: true, lastName: true, email: true, role: true },
    });
    if (!actor) return;

    await prisma.auditLog.create({
      data: {
        schoolId: input.schoolId,
        actorUserId: input.actorUserId,
        actorName: [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() || actor.email,
        actorRole: actor.role,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
  } catch (error) {
    logger.error({ err: error, action: input.action }, "Échec d'écriture du journal d'audit");
  }
}

export interface AuditLogView {
  id: number;
  actorName: string;
  actorRole: Role;
  action: AuditAction;
  targetType: string;
  targetId: number | null;
  targetLabel: string | null;
  metadata: unknown;
  createdAt: string;
}

/** Le plus récent d'abord : c'est la question qu'on se pose en ouvrant le journal. */
export async function listAuditLogs(schoolId: number, limit = 50): Promise<AuditLogView[]> {
  const logs = await prisma.auditLog.findMany({
    where: { schoolId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return logs.map((log) => ({
    id: log.id,
    actorName: log.actorName,
    actorRole: log.actorRole,
    action: log.action as AuditAction,
    targetType: log.targetType,
    targetId: log.targetId,
    targetLabel: log.targetLabel,
    metadata: log.metadata,
    createdAt: log.createdAt.toISOString(),
  }));
}
