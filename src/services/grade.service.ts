import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { badRequest, forbidden, notFound } from '../errors/AppError';
import { checkDuplicateWarning } from './grading/grading.service';
import { emitEvent } from '../lib/events';

/**
 * Garde-fou central de la saisie des notes.
 *
 * **Une seule fonction**, appelée par les cinq routes qui touchent aux notes.
 * Recopier cette vérification à chaque route est la façon classique d'oublier
 * un cas : il suffirait d'un `DELETE` sans contrôle pour qu'un enseignant
 * supprime les notes d'un collègue.
 *
 * Un enseignant n'agit que sur les couples classe × matière qui figurent dans
 * ses `teacher_assignments`. L'admin de l'école n'est pas soumis à cette
 * restriction, mais reste enfermé dans son établissement.
 */
export async function assertCanGrade(auth: AuthPayload, classId: number, subjectId: number) {
  const [klass, subject] = await Promise.all([
    prisma.class.findFirst({ where: { id: classId, schoolId: auth.schoolId } }),
    prisma.subject.findFirst({ where: { id: subjectId, schoolId: auth.schoolId } }),
  ]);

  if (!klass) throw notFound('Classe introuvable');
  if (!subject) throw notFound('Matière introuvable');

  if (auth.role === 'admin') return;
  if (auth.role !== 'teacher') throw forbidden('Seuls les enseignants saisissent des notes');

  const assignment = await prisma.teacherAssignment.findUnique({
    where: {
      teacherUserId_classId_subjectId: {
        teacherUserId: auth.userId,
        classId,
        subjectId,
      },
    },
  });

  if (!assignment) {
    throw forbidden("Vous n'enseignez pas cette matière dans cette classe");
  }
}

/** Mes classes et matières, avec l'avancement de la saisie. */
export async function listMyClasses(auth: AuthPayload, termId?: number) {
  const assignments = await prisma.teacherAssignment.findMany({
    where: { teacherUserId: auth.userId, class: { archivedAt: null } },
    include: {
      class: { select: { id: true, name: true, level: true } },
      subject: { select: { id: true, name: true } },
    },
    orderBy: { id: 'asc' },
  });

  return Promise.all(
    assignments.map(async (assignment) => {
      const effectif = await prisma.student.count({
        where: { classId: assignment.classId, archivedAt: null },
      });

      // Élèves ayant au moins une note dans ce contexte : c'est la progression
      // utile au prof, pas le nombre brut de notes saisies.
      const notes = await prisma.grade.groupBy({
        by: ['studentId'],
        where: {
          subjectId: assignment.subjectId,
          student: { classId: assignment.classId, archivedAt: null },
          ...(termId ? { termId } : {}),
        },
      });

      return {
        assignmentId: assignment.id,
        classId: assignment.classId,
        className: assignment.class.name,
        level: assignment.class.level,
        subjectId: assignment.subjectId,
        subjectName: assignment.subject.name,
        effectif,
        evalues: notes.length,
      };
    }),
  );
}

/** Table de saisie : tous les élèves de la classe et leurs notes du contexte. */
export async function getGradingTable(
  auth: AuthPayload,
  classId: number,
  subjectId: number,
  termId: number,
) {
  await assertCanGrade(auth, classId, subjectId);

  const term = await prisma.term.findFirst({ where: { id: termId, schoolId: auth.schoolId } });
  if (!term) throw notFound('Période introuvable');

  const [students, grades] = await Promise.all([
    prisma.student.findMany({
      where: { classId, schoolId: auth.schoolId, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.grade.findMany({
      where: { subjectId, termId, schoolId: auth.schoolId, student: { classId } },
      include: { gradeType: { select: { id: true, code: true, label: true, weight: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const byStudent = new Map<number, typeof grades>();
  for (const grade of grades) {
    const list = byStudent.get(grade.studentId) ?? [];
    list.push(grade);
    byStudent.set(grade.studentId, list);
  }

  return students.map((student) => ({
    ...student,
    notes: (byStudent.get(student.id) ?? []).map(toPublicGrade),
  }));
}

export async function createGrade(
  auth: AuthPayload,
  data: {
    studentId: number;
    subjectId: number;
    gradeTypeId: number;
    termId: number;
    value: number;
    maxValue?: number;
    comment?: string;
  },
) {
  const student = await prisma.student.findFirst({
    where: { id: data.studentId, schoolId: auth.schoolId, archivedAt: null },
  });
  if (!student) throw notFound('Élève introuvable');

  await assertCanGrade(auth, student.classId, data.subjectId);
  await assertContext(auth.schoolId, data.gradeTypeId, data.termId);

  const maxValue = data.maxValue ?? 20;
  assertValueInRange(data.value, maxValue);

  const warning = await checkDuplicateWarning({
    schoolId: auth.schoolId,
    studentId: data.studentId,
    subjectId: data.subjectId,
    gradeTypeId: data.gradeTypeId,
    termId: data.termId,
  });

  const grade = await prisma.grade.create({
    data: {
      schoolId: auth.schoolId,
      studentId: data.studentId,
      subjectId: data.subjectId,
      gradeTypeId: data.gradeTypeId,
      termId: data.termId,
      teacherUserId: auth.userId,
      value: data.value,
      maxValue,
      comment: data.comment ?? null,
    },
    include: { gradeType: { select: { id: true, code: true, label: true, weight: true } } },
  });

  emitEvent('grade.created', {
    gradeId: grade.id,
    schoolId: grade.schoolId,
    studentId: grade.studentId,
    subjectId: grade.subjectId,
    termId: grade.termId,
  });

  return { note: toPublicGrade(grade), avertissementDoublon: warning };
}

export async function updateGrade(
  auth: AuthPayload,
  id: number,
  data: { value?: number; maxValue?: number; gradeTypeId?: number; comment?: string | null },
) {
  const existing = await findGradeForWrite(auth, id);

  const maxValue = data.maxValue ?? Number(existing.maxValue);
  const value = data.value ?? Number(existing.value);
  assertValueInRange(value, maxValue);

  if (data.gradeTypeId !== undefined) {
    await assertContext(auth.schoolId, data.gradeTypeId, existing.termId);
  }

  const grade = await prisma.grade.update({
    where: { id },
    data: {
      ...(data.value !== undefined ? { value: data.value } : {}),
      ...(data.maxValue !== undefined ? { maxValue: data.maxValue } : {}),
      ...(data.gradeTypeId !== undefined ? { gradeTypeId: data.gradeTypeId } : {}),
      ...(data.comment !== undefined ? { comment: data.comment } : {}),
    },
    include: { gradeType: { select: { id: true, code: true, label: true, weight: true } } },
  });

  emitEvent('grade.updated', {
    gradeId: grade.id,
    schoolId: grade.schoolId,
    studentId: grade.studentId,
    subjectId: grade.subjectId,
    termId: grade.termId,
  });

  return toPublicGrade(grade);
}

export async function deleteGrade(auth: AuthPayload, id: number) {
  await findGradeForWrite(auth, id);
  await prisma.grade.delete({ where: { id } });
}

/** Historique des notes saisies par cet enseignant. */
export async function listMyGradeHistory(
  auth: AuthPayload,
  filters: { classId?: number; subjectId?: number; termId?: number },
) {
  const grades = await prisma.grade.findMany({
    where: {
      schoolId: auth.schoolId,
      teacherUserId: auth.userId,
      ...(filters.termId ? { termId: filters.termId } : {}),
      ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
      ...(filters.classId ? { student: { classId: filters.classId } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      gradeType: { select: { id: true, code: true, label: true, weight: true } },
      student: { select: { id: true, firstName: true, lastName: true, classId: true } },
      subject: { select: { id: true, name: true } },
      term: { select: { id: true, label: true } },
    },
  });

  return grades.map((grade) => ({
    ...toPublicGrade(grade),
    eleve: grade.student,
    matiere: grade.subject,
    periode: grade.term,
  }));
}

/**
 * Charge une note en vérifiant que l'appelant a le droit d'y toucher.
 * Point de passage obligé de PATCH et DELETE.
 */
async function findGradeForWrite(auth: AuthPayload, id: number) {
  const grade = await prisma.grade.findFirst({
    where: { id, schoolId: auth.schoolId },
    include: { student: { select: { classId: true } } },
  });
  if (!grade) throw notFound('Note introuvable');

  await assertCanGrade(auth, grade.student.classId, grade.subjectId);

  return grade;
}

async function assertContext(schoolId: number, gradeTypeId: number, termId: number) {
  const [gradeType, term] = await Promise.all([
    prisma.gradeType.findFirst({ where: { id: gradeTypeId, schoolId } }),
    prisma.term.findFirst({ where: { id: termId, schoolId } }),
  ]);

  if (!gradeType) throw notFound('Type de note introuvable');
  if (!term) throw notFound('Période introuvable');
}

function assertValueInRange(value: number, maxValue: number) {
  if (maxValue <= 0) throw badRequest('La note maximale doit être strictement positive');
  if (value < 0 || value > maxValue) {
    throw badRequest(`La note doit être comprise entre 0 et ${maxValue}`, { value, maxValue });
  }
}

function toPublicGrade(grade: {
  id: number;
  studentId: number;
  subjectId: number;
  termId: number;
  teacherUserId: number | null;
  value: unknown;
  maxValue: unknown;
  comment: string | null;
  createdAt: Date | null;
  gradeType: { id: number; code: string; label: string; weight: unknown };
}) {
  return {
    id: grade.id,
    studentId: grade.studentId,
    subjectId: grade.subjectId,
    termId: grade.termId,
    teacherUserId: grade.teacherUserId,
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
  };
}
