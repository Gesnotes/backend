import prisma from '../lib/prisma';
import type { AttendanceStatus } from '../generated/prisma/enums';
import type { AuthPayload } from '../types/express';
import { badRequest, conflict, forbidden, notFound } from '../errors/AppError';
import { emitEvent } from '../lib/events';
import { assertIsParentOf } from './parent.service';
import { minutesToHHMM, weekdayOfIsoDate } from './schedule.service';

/**
 * Saisie de la présence.
 *
 * Deux flux cohabitent, selon `Class.mode` :
 * - `presence` (maternelle/garderie) — un statut par élève et par jour,
 *   saisi par l'administration ou l'unique enseignant référent désigné sur
 *   la classe. Pas de créneau : un seul appel, pour éviter qu'une classe à
 *   plusieurs intervenants n'ait personne de responsable.
 * - `notes` — un statut par élève, par jour, **et par créneau** de l'emploi
 *   du temps (voir schedule.service.ts) : chaque enseignant fait l'appel
 *   pendant son propre cours, plusieurs fois par jour si sa matière y a
 *   plusieurs créneaux.
 *
 * Les deux flux sont mutuellement exclusifs par classe : voir
 * `assertCanTakeAttendanceForClass`/`assertCanTakeAttendanceForSlot`.
 */
export async function assertCanTakeAttendanceForClass(auth: AuthPayload, classId: number) {
  const klass = await prisma.class.findFirst({ where: { id: classId, schoolId: auth.schoolId } });
  if (!klass) throw notFound('Classe introuvable');

  if (klass.mode !== 'presence') {
    throw badRequest(
      "Cette classe utilise l'appel par créneau : indiquez un créneau plutôt qu'une classe.",
    );
  }

  if (auth.role === 'admin') return klass;

  if (auth.role === 'teacher' && klass.homeroomTeacherId === auth.userId) return klass;

  throw forbidden(
    "Seuls l'administration et l'enseignant référent de cette classe peuvent saisir la présence.",
  );
}

/**
 * Droit de saisir la présence d'un créneau : l'administration sans
 * restriction, ou l'enseignant précis de ce créneau — le référent de la
 * classe n'a plus de droit spécial ici, il redevient un enseignant ordinaire
 * pour ses propres créneaux. Pas de délégation/substitution en v1 :
 * l'administration reste l'échappatoire pour remplacer un professeur absent.
 */
export async function assertCanTakeAttendanceForSlot(auth: AuthPayload, slotId: number, date: string) {
  const slot = await prisma.timetableSlot.findFirst({
    where: { id: slotId, schoolId: auth.schoolId },
    include: { teacherAssignment: { include: { class: true, subject: true } } },
  });
  if (!slot) throw notFound('Créneau introuvable');
  if (slot.archivedAt) throw conflict("Ce créneau a été retiré de l'emploi du temps.");
  if (slot.teacherAssignment.class.mode !== 'notes') {
    throw badRequest("Cette classe utilise l'appel classique, pas de créneau.");
  }
  if (weekdayOfIsoDate(date) !== slot.dayOfWeek) {
    throw badRequest("Ce créneau n'a pas cours ce jour-là.");
  }

  if (auth.role === 'admin') return slot;
  if (auth.role === 'teacher' && slot.teacherAssignment.teacherUserId === auth.userId) return slot;

  throw forbidden("Seuls l'administration et l'enseignant de ce créneau peuvent saisir sa présence.");
}

export interface AttendanceEntry {
  studentId: number;
  /** `null` efface l'enregistrement du jour pour cet élève. */
  status: AttendanceStatus | null;
  comment?: string | null;
}

/** Classe (mode `presence`) ou créneau (mode `notes`) — jamais les deux. */
export interface AttendanceTarget {
  classId?: number;
  slotId?: number;
}

export interface AttendanceBatchInput extends AttendanceTarget {
  date: string;
  entries: AttendanceEntry[];
}

export type SkipReason = 'eleve_hors_classe';

export interface AttendanceBatchResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: { studentId: number; reason: SkipReason }[];
}

interface ResolvedTarget {
  classId: number;
  className: string;
  slotId: number | null;
  slot: { subjectName: string; startTime: string; endTime: string } | null;
}

/**
 * Résout une cible d'appel (classe ou créneau) vers la classe et le créneau
 * effectifs, en vérifiant au passage le droit d'y saisir la présence.
 * `date` sert à vérifier qu'un créneau a bien cours ce jour-là.
 */
async function resolveTarget(
  auth: AuthPayload,
  target: AttendanceTarget,
  date: string,
): Promise<ResolvedTarget> {
  if (target.slotId !== undefined) {
    const slot = await assertCanTakeAttendanceForSlot(auth, target.slotId, date);
    return {
      classId: slot.teacherAssignment.classId,
      className: slot.teacherAssignment.class.name,
      slotId: slot.id,
      slot: {
        subjectName: slot.teacherAssignment.subject.name,
        startTime: minutesToHHMM(slot.startMinute),
        endTime: minutesToHHMM(slot.endMinute),
      },
    };
  }

  if (target.classId === undefined) {
    throw badRequest('Indiquez la classe ou le créneau.');
  }

  const klass = await assertCanTakeAttendanceForClass(auth, target.classId);
  return { classId: klass.id, className: klass.name, slotId: null, slot: null };
}

/**
 * Saisit la présence d'une classe (ou d'un créneau) pour un jour donné, en
 * un lot.
 *
 * Reprend le pattern de `saveGradeBatch` : idempotent, transactionnel, les
 * événements ne partent qu'après le commit. `entries` décrit l'état voulu de
 * la journée ; rejouer le même lot ne réécrit rien.
 */
export async function saveAttendanceBatch(
  auth: AuthPayload,
  input: AttendanceBatchInput,
): Promise<AttendanceBatchResult> {
  const resolved = await resolveTarget(auth, input, input.date);
  const date = new Date(input.date);

  const seen = new Set<number>();
  for (const entry of input.entries) {
    if (seen.has(entry.studentId)) {
      throw badRequest('Le même élève apparaît deux fois dans cette saisie.', {
        studentId: entry.studentId,
      });
    }
    seen.add(entry.studentId);
  }

  // Seuls les élèves actuellement dans cette classe peuvent y recevoir une
  // présence : un élève déplacé entre-temps n'y figure plus.
  const students = await prisma.student.findMany({
    where: { id: { in: [...seen] }, classId: resolved.classId, schoolId: auth.schoolId, archivedAt: null },
    select: { id: true },
  });
  const validIds = new Set(students.map((student) => student.id));

  // Un seul statut par élève, par jour, et par créneau (contrainte
  // d'unicité) : la recherche filtre par créneau (null pour les classes
  // mode presence) mais pas par classe, qui pourrait diverger si l'élève a
  // changé de classe le jour même.
  const existing = await prisma.attendance.findMany({
    where: { studentId: { in: [...validIds] }, date, slotId: resolved.slotId },
    select: { id: true, studentId: true, classId: true, status: true, comment: true },
  });
  const byStudent = new Map(existing.map((record) => [record.studentId, record]));

  const skipped: AttendanceBatchResult['skipped'] = [];
  const toCreate: AttendanceEntry[] = [];
  const toUpdate: { id: number; entry: AttendanceEntry }[] = [];
  const toDelete: number[] = [];
  let unchanged = 0;

  for (const entry of input.entries) {
    if (!validIds.has(entry.studentId)) {
      skipped.push({ studentId: entry.studentId, reason: 'eleve_hors_classe' });
      continue;
    }

    const record = byStudent.get(entry.studentId);

    if (entry.status === null) {
      if (record) toDelete.push(record.id);
      continue;
    }

    if (!record) {
      toCreate.push(entry);
      continue;
    }

    const comment = entry.comment === undefined ? record.comment : entry.comment || null;
    const identical =
      record.status === entry.status && record.classId === resolved.classId && record.comment === comment;

    if (identical) unchanged += 1;
    else toUpdate.push({ id: record.id, entry });
  }

  type WrittenRecord = { id: number; studentId: number; status: AttendanceStatus };

  const { created, updated } = await prisma.$transaction(async (tx) => {
    if (toDelete.length > 0) {
      await tx.attendance.deleteMany({ where: { id: { in: toDelete } } });
    }

    const updated: WrittenRecord[] = [];
    for (const { id, entry } of toUpdate) {
      const record = await tx.attendance.update({
        where: { id },
        data: {
          status: entry.status as AttendanceStatus,
          classId: resolved.classId,
          recordedByUserId: auth.userId,
          ...(entry.comment !== undefined ? { comment: entry.comment || null } : {}),
        },
      });
      updated.push({ id: record.id, studentId: record.studentId, status: record.status });
    }

    const created: WrittenRecord[] = [];
    for (const entry of toCreate) {
      const record = await tx.attendance.create({
        data: {
          schoolId: auth.schoolId,
          studentId: entry.studentId,
          classId: resolved.classId,
          slotId: resolved.slotId,
          date,
          status: entry.status as AttendanceStatus,
          comment: entry.comment || null,
          recordedByUserId: auth.userId,
        },
      });
      created.push({ id: record.id, studentId: record.studentId, status: record.status });
    }

    return { created, updated };
  });

  // Notifications émises après le commit, et seulement pour absent/retard :
  // notifier une famille à chaque « présent » saisi noierait le seul message
  // qui compte pour elle.
  for (const record of [...created, ...updated]) {
    if (record.status === 'present') continue;
    emitEvent('attendance.marked', {
      attendanceId: record.id,
      schoolId: auth.schoolId,
      studentId: record.studentId,
      classId: resolved.classId,
      slotId: resolved.slotId,
      status: record.status,
    });
  }

  return {
    created: created.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
    unchanged,
    skipped,
  };
}

/** Feuille de présence d'une classe ou d'un créneau pour un jour : tous ses élèves, chacun avec son statut (ou aucun). */
export async function getAttendanceSheet(auth: AuthPayload, target: AttendanceTarget, date: string) {
  const resolved = await resolveTarget(auth, target, date);
  const day = new Date(date);

  const [students, records] = await Promise.all([
    prisma.student.findMany({
      where: { classId: resolved.classId, schoolId: auth.schoolId, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.attendance.findMany({
      where: { classId: resolved.classId, schoolId: auth.schoolId, date: day, slotId: resolved.slotId },
      select: { studentId: true, status: true, comment: true },
    }),
  ]);

  const byStudent = new Map(records.map((record) => [record.studentId, record]));

  return {
    classId: resolved.classId,
    className: resolved.className,
    slotId: resolved.slotId,
    slot: resolved.slot,
    date,
    students: students.map((student) => {
      const record = byStudent.get(student.id);
      return { ...student, status: record?.status ?? null, comment: record?.comment ?? null };
    }),
  };
}

/** Historique de présence d'un enfant. Accessible au parent, à l'admin et au professeur de sa classe. */
export async function listChildAttendance(
  auth: AuthPayload,
  studentId: number,
  filters: { from?: string; to?: string },
) {
  await assertIsParentOf(auth, studentId);

  const records = await prisma.attendance.findMany({
    where: {
      studentId,
      schoolId: auth.schoolId,
      ...(filters.from || filters.to
        ? {
            date: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    },
    orderBy: { date: 'desc' },
    take: 200,
    select: {
      id: true,
      date: true,
      status: true,
      comment: true,
      classId: true,
      slot: { select: { teacherAssignment: { select: { subject: { select: { name: true } } } } } },
    },
  });

  return records.map(({ slot, ...record }) => ({
    ...record,
    subjectName: slot?.teacherAssignment.subject.name ?? null,
  }));
}
