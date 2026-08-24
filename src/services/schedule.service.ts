import prisma from '../lib/prisma';
import type { Prisma } from '../generated/prisma/client';
import type { ClassMode, Weekday } from '../generated/prisma/enums';
import type { AuthPayload } from '../types/express';
import { badRequest, conflict, forbidden, notFound } from '../errors/AppError';

/**
 * Emploi du temps : créneaux récurrents (jour de semaine + horaire) d'une
 * affectation enseignant×classe×matière. Ne concerne que les classes en
 * mode `notes` — les classes `presence` (maternelle/garderie) gardent le
 * flux historique de présence, sans créneau (voir attendance.service.ts).
 *
 * Un créneau appartient à une classe précise (`teacherAssignment.classId`) :
 * toutes les fonctions ci-dessous vérifient que le créneau visé appartient
 * bien à la classe passée en paramètre, pour qu'un identifiant de créneau
 * deviné ne laisse pas agir sur la classe d'un autre enseignant.
 */

export interface SlotInput {
  teacherAssignmentId: number;
  dayOfWeek: Weekday;
  startMinute: number;
  endMinute: number;
}

export interface SlotPatch {
  teacherAssignmentId?: number;
  dayOfWeek?: Weekday;
  startMinute?: number;
  endMinute?: number;
}

export interface SlotView {
  id: number;
  teacherAssignmentId: number;
  classId: number;
  className: string;
  subjectId: number;
  subjectName: string;
  teacherUserId: number;
  teacherFirstName: string | null;
  teacherLastName: string | null;
  dayOfWeek: Weekday;
  startTime: string;
  endTime: string;
  archivedAt: string | null;
}

/**
 * Jour de semaine d'une date ISO (`"2026-08-17"` → `lundi`).
 *
 * `new Date("YYYY-MM-DD")` est toujours interprétée en UTC minuit par le
 * moteur JS (spec ECMA-262) : `getUTCDay()` donne donc le bon jour quel que
 * soit le fuseau du serveur. Different de « quel jour sommes-nous
 * maintenant ? » (déjà source d'un bug UTC-vs-fuseau-école ailleurs, voir
 * dashboard.service.ts) — ici la date est déjà choisie par l'appelant, il
 * ne reste qu'à la convertir en jour de semaine, une opération sans
 * ambiguïté de fuseau.
 */
const WEEKDAYS_BY_JS_DAY: Weekday[] = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export function weekdayOfIsoDate(date: string): Weekday {
  return WEEKDAYS_BY_JS_DAY[new Date(date).getUTCDay()]!;
}

export function minutesToHHMM(minutes: number): string {
  const hours = Math.floor(minutes / 60).toString().padStart(2, '0');
  const rest = (minutes % 60).toString().padStart(2, '0');
  return `${hours}:${rest}`;
}

export function hhmmToMinutes(value: string): number {
  const parts = value.split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

const slotSelect = {
  id: true,
  teacherAssignmentId: true,
  dayOfWeek: true,
  startMinute: true,
  endMinute: true,
  archivedAt: true,
  teacherAssignment: {
    select: {
      teacherUserId: true,
      classId: true,
      subjectId: true,
      teacher: { select: { firstName: true, lastName: true } },
      class: { select: { name: true } },
      subject: { select: { name: true } },
    },
  },
} as const;

type SlotRow = {
  id: number;
  teacherAssignmentId: number;
  dayOfWeek: Weekday;
  startMinute: number;
  endMinute: number;
  archivedAt: Date | null;
  teacherAssignment: {
    teacherUserId: number;
    classId: number;
    subjectId: number;
    teacher: { firstName: string | null; lastName: string | null };
    class: { name: string };
    subject: { name: string };
  };
};

function toView(slot: SlotRow): SlotView {
  return {
    id: slot.id,
    teacherAssignmentId: slot.teacherAssignmentId,
    classId: slot.teacherAssignment.classId,
    className: slot.teacherAssignment.class.name,
    subjectId: slot.teacherAssignment.subjectId,
    subjectName: slot.teacherAssignment.subject.name,
    teacherUserId: slot.teacherAssignment.teacherUserId,
    teacherFirstName: slot.teacherAssignment.teacher.firstName,
    teacherLastName: slot.teacherAssignment.teacher.lastName,
    dayOfWeek: slot.dayOfWeek,
    startTime: minutesToHHMM(slot.startMinute),
    endTime: minutesToHHMM(slot.endMinute),
    archivedAt: slot.archivedAt ? slot.archivedAt.toISOString() : null,
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function slotLabel(slot: SlotRow): string {
  const jour = capitalize(slot.dayOfWeek);
  return `${slot.teacherAssignment.subject.name} · ${slot.teacherAssignment.class.name} · ${jour} ${minutesToHHMM(slot.startMinute)}-${minutesToHHMM(slot.endMinute)}`;
}

function assertValidRange(startMinute: number, endMinute: number) {
  if (startMinute < 0 || startMinute >= 1440) {
    throw badRequest("L'heure de début n'est pas valable.");
  }
  if (endMinute <= startMinute || endMinute > 1440) {
    throw badRequest("L'heure de fin doit venir après l'heure de début.");
  }
}

async function getClassOrThrow(schoolId: number, classId: number) {
  const klass = await prisma.class.findFirst({ where: { id: classId, schoolId } });
  if (!klass) throw notFound('Classe introuvable');
  return klass;
}

/**
 * Droit de consulter l'emploi du temps d'une classe : l'admin sans
 * restriction, un enseignant seulement s'il y a au moins une affectation —
 * même logique que `assertCanViewClass` (class.service.ts), pour qu'un
 * enseignant ne découvre pas les horaires d'une classe où il n'intervient
 * pas.
 */
async function assertCanViewSchedule(auth: AuthPayload, classId: number) {
  const klass = await getClassOrThrow(auth.schoolId, classId);
  if (auth.role === 'admin') return klass;

  const assignment = await prisma.teacherAssignment.findFirst({
    where: { teacherUserId: auth.userId, classId },
  });
  if (!assignment) throw forbidden("Vous n'enseignez pas dans cette classe.");
  return klass;
}

/**
 * Un créneau n'a de sens que pour une classe en mode `notes` : le mode
 * `presence` (maternelle/garderie) n'a pas de notion de matière/cours, et
 * garde son propre flux d'appel (référent + admin, un appel par jour).
 */
function assertClassUsesSchedule(klass: { mode: ClassMode }) {
  if (klass.mode !== 'notes') {
    throw badRequest(
      "Cette classe utilise l'appel classique : l'emploi du temps ne concerne que les classes en mode « notes ».",
    );
  }
}

async function getSlotOrThrow(schoolId: number, classId: number, id: number) {
  const slot = await prisma.timetableSlot.findFirst({
    where: { id, schoolId, teacherAssignment: { classId } },
    select: slotSelect,
  });
  if (!slot) throw notFound('Créneau introuvable');
  return slot;
}

/** Vérifie que l'affectation visée existe, appartient à l'école, et à cette classe précisément. */
async function resolveAssignment(schoolId: number, classId: number, teacherAssignmentId: number) {
  const assignment = await prisma.teacherAssignment.findFirst({
    where: { id: teacherAssignmentId, schoolId, classId },
    select: { teacherUserId: true, classId: true },
  });
  if (!assignment) throw notFound('Affectation introuvable pour cette classe');
  return assignment;
}

/**
 * Un enseignant ne peut pas avoir deux créneaux qui se chevauchent le même
 * jour (deux classes en même temps), ni une classe avoir deux créneaux qui
 * se chevauchent (deux matières en même temps). Simple test d'intervalles
 * entiers `[start, end)` — pas besoin de contrainte d'exclusion Postgres.
 */
async function assertNoOverlap(
  schoolId: number,
  assignment: { teacherUserId: number; classId: number },
  input: { dayOfWeek: Weekday; startMinute: number; endMinute: number },
  excludeId?: number,
) {
  const overlapWhere = (extra: Prisma.TimetableSlotWhereInput): Prisma.TimetableSlotWhereInput => ({
    schoolId,
    archivedAt: null,
    dayOfWeek: input.dayOfWeek,
    ...(excludeId ? { id: { not: excludeId } } : {}),
    startMinute: { lt: input.endMinute },
    endMinute: { gt: input.startMinute },
    ...extra,
  });

  const teacherClash = await prisma.timetableSlot.findFirst({
    where: overlapWhere({ teacherAssignment: { teacherUserId: assignment.teacherUserId } }),
    select: { teacherAssignment: { select: { class: { select: { name: true } }, subject: { select: { name: true } } } } },
  });
  if (teacherClash) {
    throw conflict(
      `Cet enseignant a déjà cours en ${teacherClash.teacherAssignment.class.name} (${teacherClash.teacherAssignment.subject.name}) sur ce créneau.`,
    );
  }

  const classClash = await prisma.timetableSlot.findFirst({
    where: overlapWhere({ teacherAssignment: { classId: assignment.classId } }),
    select: { teacherAssignment: { select: { subject: { select: { name: true } } } } },
  });
  if (classClash) {
    throw conflict(`Cette classe a déjà ${classClash.teacherAssignment.subject.name} sur ce créneau.`);
  }
}

/** Emploi du temps d'une classe, du lundi au dimanche puis par heure croissante. */
export async function listSlotsForClass(
  auth: AuthPayload,
  classId: number,
  includeArchived = false,
): Promise<SlotView[]> {
  await assertCanViewSchedule(auth, classId);
  return listSlotsForClassRaw(auth.schoolId, classId, includeArchived);
}

/**
 * Même requête que `listSlotsForClass`, sans le contrôle d'accès enseignant.
 * Réservé aux appelants qui ont déjà vérifié le droit de lecture par une
 * autre voie — `parent.service.ts::getChildSchedule` via `assertIsParentOf`.
 */
export async function listSlotsForClassRaw(
  schoolId: number,
  classId: number,
  includeArchived = false,
): Promise<SlotView[]> {
  const slots = await prisma.timetableSlot.findMany({
    where: {
      schoolId,
      teacherAssignment: { classId },
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    select: slotSelect,
  });

  return slots.map(toView);
}

export async function createSlot(schoolId: number, classId: number, input: SlotInput): Promise<SlotView> {
  const klass = await getClassOrThrow(schoolId, classId);
  assertClassUsesSchedule(klass);
  assertValidRange(input.startMinute, input.endMinute);

  const assignment = await resolveAssignment(schoolId, classId, input.teacherAssignmentId);
  await assertNoOverlap(schoolId, assignment, input);

  const slot = await prisma.timetableSlot.create({
    data: {
      schoolId,
      teacherAssignmentId: input.teacherAssignmentId,
      dayOfWeek: input.dayOfWeek,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
    },
    select: slotSelect,
  });

  return toView(slot);
}

export async function updateSlot(
  schoolId: number,
  classId: number,
  id: number,
  patch: SlotPatch,
): Promise<SlotView> {
  const existing = await getSlotOrThrow(schoolId, classId, id);

  const teacherAssignmentId = patch.teacherAssignmentId ?? existing.teacherAssignmentId;
  const dayOfWeek = patch.dayOfWeek ?? existing.dayOfWeek;
  const startMinute = patch.startMinute ?? existing.startMinute;
  const endMinute = patch.endMinute ?? existing.endMinute;
  assertValidRange(startMinute, endMinute);

  const assignment =
    teacherAssignmentId === existing.teacherAssignmentId
      ? { teacherUserId: existing.teacherAssignment.teacherUserId, classId: existing.teacherAssignment.classId }
      : await resolveAssignment(schoolId, classId, teacherAssignmentId);

  await assertNoOverlap(schoolId, assignment, { dayOfWeek, startMinute, endMinute }, id);

  const slot = await prisma.timetableSlot.update({
    where: { id },
    data: { teacherAssignmentId, dayOfWeek, startMinute, endMinute },
    select: slotSelect,
  });

  return toView(slot);
}

/** Archivage : comportement par défaut, sort le créneau de l'emploi du temps sans rien détruire. */
export async function archiveSlot(schoolId: number, classId: number, id: number): Promise<SlotView> {
  await getSlotOrThrow(schoolId, classId, id);

  const slot = await prisma.timetableSlot.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: slotSelect,
  });

  return toView(slot);
}

export async function restoreSlot(schoolId: number, classId: number, id: number): Promise<SlotView> {
  const existing = await getSlotOrThrow(schoolId, classId, id);

  // Le chevauchement n'est contrôlé qu'entre créneaux actifs : restaurer un
  // créneau redevenu incompatible avec l'emploi du temps actuel doit être
  // refusé, comme pour une période (voir term.service.ts::restoreTerm).
  await assertNoOverlap(
    schoolId,
    { teacherUserId: existing.teacherAssignment.teacherUserId, classId: existing.teacherAssignment.classId },
    { dayOfWeek: existing.dayOfWeek, startMinute: existing.startMinute, endMinute: existing.endMinute },
    id,
  );

  const slot = await prisma.timetableSlot.update({
    where: { id },
    data: { archivedAt: null },
    select: slotSelect,
  });

  return toView(slot);
}

/**
 * Suppression définitive, réservée à un créneau déjà archivé, avec retapage
 * du libellé exact — même garde-fou que pour une période ou une classe (voir
 * term.service.ts). `Attendance.slot` sera posé en RESTRICT (migration à
 * venir) : ce filet SQL bloquera toute suppression d'un créneau qui a déjà
 * de la présence enregistrée, même si ce contrôle applicatif était oublié.
 */
export async function deleteSlotPermanently(
  schoolId: number,
  classId: number,
  id: number,
  expectedLabel: string,
): Promise<void> {
  const existing = await getSlotOrThrow(schoolId, classId, id);

  if (!existing.archivedAt) {
    throw conflict('Archivez le créneau avant de le supprimer définitivement.', { slotId: id });
  }

  const label = slotLabel(existing);
  if (expectedLabel.trim().toLowerCase() !== label.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au libellé du créneau. Cette suppression est définitive.',
      { attendu: label },
    );
  }

  await prisma.timetableSlot.delete({ where: { id } });
}

/**
 * Mes créneaux : ce qu'un enseignant voit pour choisir sur quel cours faire
 * l'appel — voir `assertCanTakeAttendanceForSlot` (attendance.service.ts)
 * pour le contrôle d'accès à la saisie elle-même.
 *
 * `date` restreint à un seul jour (usage historique, appel du jour) ; omis,
 * renvoie toute la semaine récurrente — utilisé par la vue « mon emploi du
 * temps » de l'enseignant.
 */
export async function listMySlotsForDate(auth: AuthPayload, date?: string): Promise<SlotView[]> {
  const dayOfWeek = date ? weekdayOfIsoDate(date) : undefined;

  const slots = await prisma.timetableSlot.findMany({
    where: {
      schoolId: auth.schoolId,
      archivedAt: null,
      ...(dayOfWeek ? { dayOfWeek } : {}),
      teacherAssignment: { teacherUserId: auth.userId },
    },
    orderBy: dayOfWeek ? [{ startMinute: 'asc' }] : [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    select: slotSelect,
  });

  return slots.map(toView);
}
