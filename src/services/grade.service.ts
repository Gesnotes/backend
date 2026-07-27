import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { badRequest, conflict, forbidden, notFound } from '../errors/AppError';
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
  // `schoolId` explicite sur chaque requête : l'isolation ne doit pas reposer
  // sur la propriété transitive « les affectations d'un utilisateur sont dans
  // son école », même si la base la garantit désormais.
  const assignments = await prisma.teacherAssignment.findMany({
    where: {
      schoolId: auth.schoolId,
      teacherUserId: auth.userId,
      class: { archivedAt: null },
    },
    include: {
      class: { select: { id: true, name: true, level: true } },
      subject: { select: { id: true, name: true } },
    },
    orderBy: { id: 'asc' },
  });

  const classIds = [...new Set(assignments.map((a) => a.classId))];
  const subjectIds = [...new Set(assignments.map((a) => a.subjectId))];

  // Trois requêtes au total (celle-ci comprise), quel que soit le nombre
  // d'affectations. En boucle, un professeur enseignant dans douze classes
  // paierait vingt-quatre allers-retours à chaque ouverture de son accueil.
  const [effectifs, notes] = await Promise.all([
    prisma.student.groupBy({
      by: ['classId'],
      where: { schoolId: auth.schoolId, classId: { in: classIds }, archivedAt: null },
      _count: { _all: true },
    }),
    // `distinct` porte la règle métier : un élève évalué compte une fois par
    // matière, quel que soit son nombre de notes. La classe vient de la même
    // lecture, ce qui évite une requête supplémentaire sur les élèves.
    prisma.grade.findMany({
      where: {
        schoolId: auth.schoolId,
        subjectId: { in: subjectIds },
        student: { classId: { in: classIds }, archivedAt: null },
        ...(termId ? { termId } : {}),
      },
      distinct: ['subjectId', 'studentId'],
      select: { subjectId: true, student: { select: { classId: true } } },
    }),
  ]);

  const effectifParClasse = new Map(effectifs.map((e) => [e.classId, e._count._all]));

  const evalues = new Map<string, number>();
  for (const note of notes) {
    const cle = `${note.student.classId}:${note.subjectId}`;
    evalues.set(cle, (evalues.get(cle) ?? 0) + 1);
  }

  return assignments.map((assignment) => ({
    assignmentId: assignment.id,
    classId: assignment.classId,
    className: assignment.class.name,
    level: assignment.class.level,
    subjectId: assignment.subjectId,
    subjectName: assignment.subject.name,
    effectif: effectifParClasse.get(assignment.classId) ?? 0,
    evalues: evalues.get(`${assignment.classId}:${assignment.subjectId}`) ?? 0,
  }));
}

/**
 * Grille de saisie d'une **évaluation** : tous les élèves de sa classe, chacun
 * avec sa note pour cette évaluation (une seule possible, ou aucune).
 *
 * L'ambiguïté « plusieurs notes du même type » a disparu : une évaluation
 * désigne exactement une colonne de notes.
 */
export async function getEvaluationGrid(auth: AuthPayload, evaluationId: number) {
  const evaluation = await prisma.evaluation.findFirst({
    where: { id: evaluationId, schoolId: auth.schoolId },
    include: { gradeType: { select: { id: true, code: true, label: true, weight: true } } },
  });
  if (!evaluation) throw notFound('Évaluation introuvable');

  await assertCanGrade(auth, evaluation.classId, evaluation.subjectId);

  const [students, grades] = await Promise.all([
    prisma.student.findMany({
      where: { classId: evaluation.classId, schoolId: auth.schoolId, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.grade.findMany({
      where: { evaluationId, schoolId: auth.schoolId },
      select: { studentId: true, value: true, comment: true },
    }),
  ]);

  const byStudent = new Map(grades.map((grade) => [grade.studentId, grade]));

  return {
    evaluation: {
      id: evaluation.id,
      classId: evaluation.classId,
      subjectId: evaluation.subjectId,
      termId: evaluation.termId,
      label: evaluation.label,
      date: evaluation.date,
      maxValue: Number(evaluation.maxValue),
      type: {
        id: evaluation.gradeType.id,
        code: evaluation.gradeType.code,
        label: evaluation.gradeType.label,
        weight: Number(evaluation.gradeType.weight),
      },
    },
    students: students.map((student) => {
      const note = byStudent.get(student.id);
      return {
        ...student,
        note: note ? { value: Number(note.value), comment: note.comment } : null,
      };
    }),
  };
}

/**
 * Note isolée, rattachée à une évaluation existante.
 *
 * La matière, le type, la période et le barème sont ceux de l'évaluation :
 * une note ne peut plus diverger de son évaluation. La contrainte d'unicité
 * (une note par élève et par évaluation) est traduite en 409 lisible.
 */
export async function createGrade(
  auth: AuthPayload,
  data: {
    evaluationId: number;
    studentId: number;
    value: number;
    comment?: string;
  },
) {
  const evaluation = await prisma.evaluation.findFirst({
    where: { id: data.evaluationId, schoolId: auth.schoolId },
    include: { gradeType: { select: { id: true, code: true, label: true, weight: true } } },
  });
  if (!evaluation) throw notFound('Évaluation introuvable');

  const student = await prisma.student.findFirst({
    where: { id: data.studentId, schoolId: auth.schoolId, archivedAt: null },
  });
  if (!student) throw notFound('Élève introuvable');
  if (student.classId !== evaluation.classId) {
    throw badRequest("L'élève n'appartient pas à la classe de cette évaluation");
  }

  await assertCanGrade(auth, evaluation.classId, evaluation.subjectId);
  await assertTermOpen(auth, evaluation.termId);

  const maxValue = Number(evaluation.maxValue);
  assertValueInRange(data.value, maxValue);

  const already = await prisma.grade.findUnique({
    where: {
      evaluationId_studentId: { evaluationId: evaluation.id, studentId: data.studentId },
    },
  });
  if (already) {
    throw conflict('Cet élève a déjà une note pour cette évaluation', { gradeId: already.id });
  }

  const grade = await prisma.grade.create({
    data: {
      schoolId: auth.schoolId,
      studentId: data.studentId,
      evaluationId: evaluation.id,
      subjectId: evaluation.subjectId,
      gradeTypeId: evaluation.gradeTypeId,
      termId: evaluation.termId,
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

  return toPublicGrade(grade);
}

/**
 * Correction d'une note : seules la valeur et le commentaire changent. La
 * matière, le type et le barème appartiennent désormais à l'évaluation et se
 * modifient sur elle.
 */
export async function updateGrade(
  auth: AuthPayload,
  id: number,
  data: { value?: number; comment?: string | null },
) {
  const existing = await findGradeForWrite(auth, id);

  const value = data.value ?? Number(existing.value);
  assertValueInRange(value, Number(existing.maxValue));

  const grade = await prisma.grade.update({
    where: { id },
    data: {
      ...(data.value !== undefined ? { value: data.value } : {}),
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
      evaluation: { select: { id: true, label: true, date: true } },
      student: { select: { id: true, firstName: true, lastName: true, classId: true } },
      subject: { select: { id: true, name: true } },
      term: { select: { id: true, label: true } },
    },
  });

  return grades.map((grade) => ({
    ...toPublicGrade(grade),
    evaluation: grade.evaluation,
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
  await assertTermOpen(auth, grade.termId);

  return grade;
}

/**
 * Interdit à un enseignant de saisir/modifier des notes sur un trimestre déjà
 * clos (date de fin passée). L'administration garde la main — corrections,
 * rattrapages, erreurs constatées après coup relèvent d'elle, pas du prof.
 */
export function assertTermWritable(auth: AuthPayload, term: { endDate: Date | null }) {
  if (auth.role === 'admin') return;
  if (!term.endDate) return;

  const today = new Date().toISOString().slice(0, 10);
  const end = term.endDate.toISOString().slice(0, 10);
  if (end < today) {
    throw forbidden(
      "Ce trimestre est terminé : la saisie n'est plus possible. Contactez l'administration.",
    );
  }
}

/** Charge la période et applique {@link assertTermWritable}. */
export async function assertTermOpen(auth: AuthPayload, termId: number) {
  const term = await prisma.term.findFirst({
    where: { id: termId, schoolId: auth.schoolId },
    select: { endDate: true },
  });
  if (term) assertTermWritable(auth, term);
}

export async function assertContext(schoolId: number, gradeTypeId: number, termId: number) {
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
  evaluationId: number;
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
    evaluationId: grade.evaluationId,
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
