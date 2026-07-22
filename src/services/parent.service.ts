import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { notFound } from '../errors/AppError';
import { computeStudentResult } from './grading/grading.service';

/**
 * Garde-fou de l'espace parent, symétrique de `assertCanGrade`.
 *
 * **Une seule fonction**, appelée par les quatre routes qui exposent des
 * données d'élève à un parent.
 *
 * Le refus renvoie 404 et non 403 : répondre « interdit » confirmerait
 * l'existence de l'élève et permettrait, en énumérant les identifiants, de
 * reconstituer les effectifs d'un établissement.
 */
export async function assertIsParentOf(auth: AuthPayload, studentId: number) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId: auth.schoolId },
    select: { id: true, classId: true },
  });
  if (!student) throw notFound('Élève introuvable');

  // L'administration et les enseignants de l'école gardent l'accès en lecture.
  if (auth.role === 'admin') return student;

  if (auth.role === 'teacher') {
    const teaches = await prisma.teacherAssignment.findFirst({
      where: { teacherUserId: auth.userId, classId: student.classId },
    });
    if (!teaches) throw notFound('Élève introuvable');
    return student;
  }

  const link = await prisma.studentParent.findUnique({
    where: { studentId_parentUserId: { studentId, parentUserId: auth.userId } },
  });
  if (!link) throw notFound('Élève introuvable');

  return student;
}

/** Mes enfants, avec leur classe et leur moyenne sur la période demandée. */
export async function listMyChildren(auth: AuthPayload, termId?: number) {
  const links = await prisma.studentParent.findMany({
    where: { parentUserId: auth.userId, student: { schoolId: auth.schoolId, archivedAt: null } },
    include: {
      student: {
        include: { class: { select: { id: true, name: true, level: true } } },
      },
    },
  });

  return Promise.all(
    links.map(async ({ student }) => ({
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      classe: student.class,
      average:
        termId === undefined
          ? null
          : (await computeStudentResult(auth.schoolId, student.id, termId)).average,
    })),
  );
}

/** Détail d'un enfant : moyenne générale et moyenne par matière. */
export async function getChildDetail(auth: AuthPayload, studentId: number, termId: number) {
  await assertIsParentOf(auth, studentId);

  const term = await prisma.term.findFirst({ where: { id: termId, schoolId: auth.schoolId } });
  if (!term) throw notFound('Période introuvable');

  const result = await computeStudentResult(auth.schoolId, studentId, termId);
  return { ...result, termId, termLabel: term.label };
}

/** Historique complet des notes d'un enfant, filtrable par période. */
export async function listChildGrades(
  auth: AuthPayload,
  studentId: number,
  filters: { termId?: number; subjectId?: number },
) {
  await assertIsParentOf(auth, studentId);

  const grades = await prisma.grade.findMany({
    where: {
      studentId,
      schoolId: auth.schoolId,
      ...(filters.termId ? { termId: filters.termId } : {}),
      ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      gradeType: { select: { id: true, code: true, label: true, weight: true } },
      subject: { select: { id: true, name: true } },
      term: { select: { id: true, label: true } },
      teacher: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  return grades.map(toParentGrade);
}

/**
 * Détail d'une note. Accessible au parent de l'élève comme au professeur de
 * sa classe — deux règles d'accès sur la même route, résolues par
 * `assertIsParentOf`, qui traite les trois rôles.
 */
export async function getGradeDetail(auth: AuthPayload, gradeId: number) {
  const grade = await prisma.grade.findFirst({
    where: { id: gradeId, schoolId: auth.schoolId },
    include: {
      gradeType: { select: { id: true, code: true, label: true, weight: true } },
      subject: { select: { id: true, name: true } },
      term: { select: { id: true, label: true } },
      teacher: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!grade) throw notFound('Note introuvable');

  await assertIsParentOf(auth, grade.studentId);

  return toParentGrade(grade);
}

function toParentGrade(grade: {
  id: number;
  studentId: number;
  value: unknown;
  maxValue: unknown;
  comment: string | null;
  createdAt: Date | null;
  gradeType: { id: number; code: string; label: string; weight: unknown };
  subject: { id: number; name: string };
  term: { id: number; label: string };
  teacher: { id: number; firstName: string | null; lastName: string | null } | null;
}) {
  return {
    id: grade.id,
    studentId: grade.studentId,
    value: Number(grade.value),
    maxValue: Number(grade.maxValue),
    comment: grade.comment,
    createdAt: grade.createdAt,
    type: {
      id: grade.gradeType.id,
      code: grade.gradeType.code,
      label: grade.gradeType.label,
      weight: Number(grade.gradeType.weight),
    },
    matiere: grade.subject,
    periode: grade.term,
    // Le professeur est identifié par son nom, jamais par son email.
    professeur: grade.teacher
      ? { id: grade.teacher.id, firstName: grade.teacher.firstName, lastName: grade.teacher.lastName }
      : null,
  };
}
