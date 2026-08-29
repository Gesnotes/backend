import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { badRequest, conflict, forbidden, notFound } from '../errors/AppError';
import { emitEvent } from '../lib/events';
import { recordAudit } from './audit.service';
import { isOpenForEntry } from './term.service';

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
  if (auth.role !== 'teacher') throw forbidden('Seuls les enseignants peuvent saisir des notes.');

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
    throw forbidden("Vous n'enseignez pas cette matière dans cette classe.");
  }
}

type ClassSubjectPair = {
  id: number;
  classId: number;
  className: string;
  level: string;
  subjectId: number;
  subjectName: string;
};

/**
 * Mes classes et matières, avec l'avancement de la saisie.
 *
 * Pour un enseignant, ce sont ses `teacher_assignments`. L'admin n'en a pas :
 * il voit l'école entière, un couple classe × matière par affectation —
 * toutes celles de l'école, pas seulement les siennes. `SubjectCoefficient`
 * ne convient pas ici : c'est une surcharge facultative du coefficient de
 * calcul de moyenne (le coefficient par défaut de la matière s'applique déjà
 * sans elle), pas une déclaration de ce qui se note dans une classe.
 */
export async function listMyClasses(auth: AuthPayload, termId?: number) {
  const pairs =
    auth.role === 'admin' ? await listSchoolPairs(auth.schoolId) : await listMyPairs(auth);

  return buildGradingProgress(auth.schoolId, pairs, termId);
}

// `schoolId` explicite sur chaque requête : l'isolation ne doit pas reposer
// sur la propriété transitive « les affectations d'un utilisateur sont dans
// son école », même si la base la garantit désormais.
async function listMyPairs(auth: AuthPayload): Promise<ClassSubjectPair[]> {
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

  return assignments.map((assignment) => ({
    id: assignment.id,
    classId: assignment.classId,
    className: assignment.class.name,
    level: assignment.class.level,
    subjectId: assignment.subjectId,
    subjectName: assignment.subject.name,
  }));
}

// Les classes en mode présence n'ont pas de matières à noter (voir
// `assertClassAllowsGrading` côté évaluations) : les exclure ici évite de
// proposer un couple que la création d'évaluation refuserait ensuite.
//
// Une matière est rattachée à une classe soit par une affectation
// d'enseignant, soit par un simple `SubjectCoefficient` sans enseignant
// désigné (même définition que `ClassSubjectsPanel.tsx` côté front) : un
// admin n'est restreint que par son école, pas par les affectations
// existantes, donc les deux sources doivent apparaître ici.
async function listSchoolPairs(schoolId: number): Promise<ClassSubjectPair[]> {
  const classFilter = { archivedAt: null, mode: 'notes' as const };

  const [assignments, coefficients] = await Promise.all([
    prisma.teacherAssignment.findMany({
      where: { schoolId, class: classFilter },
      include: {
        class: { select: { id: true, name: true, level: true } },
        subject: { select: { id: true, name: true } },
      },
    }),
    prisma.subjectCoefficient.findMany({
      where: { class: { schoolId, ...classFilter } },
      include: {
        class: { select: { id: true, name: true, level: true } },
        subject: { select: { id: true, name: true } },
      },
    }),
  ]);

  // Plusieurs enseignants peuvent partager un même couple classe × matière
  // (co-intervention), et une matière peut être rattachée sans aucun
  // enseignant : une seule ligne par couple, quelle que soit sa source.
  const seen = new Map<string, ClassSubjectPair>();
  const addPair = (pair: {
    classId: number;
    className: string;
    level: string;
    subjectId: number;
    subjectName: string;
  }) => {
    const key = `${pair.classId}:${pair.subjectId}`;
    if (seen.has(key)) return;
    seen.set(key, {
      // Pas d'affectation unique dont hériter un id : celui-ci n'a besoin
      // que d'être stable et unique pour ce couple, jamais réutilisé ailleurs.
      id: pair.classId * 1_000_000 + pair.subjectId,
      ...pair,
    });
  };

  for (const assignment of assignments) {
    addPair({
      classId: assignment.classId,
      className: assignment.class.name,
      level: assignment.class.level,
      subjectId: assignment.subjectId,
      subjectName: assignment.subject.name,
    });
  }
  for (const coefficient of coefficients) {
    addPair({
      classId: coefficient.classId,
      className: coefficient.class.name,
      level: coefficient.class.level,
      subjectId: coefficient.subjectId,
      subjectName: coefficient.subject.name,
    });
  }

  return [...seen.values()].sort(
    (a, b) => a.level.localeCompare(b.level) || a.className.localeCompare(b.className),
  );
}

async function buildGradingProgress(schoolId: number, pairs: ClassSubjectPair[], termId?: number) {
  const classIds = [...new Set(pairs.map((p) => p.classId))];
  const subjectIds = [...new Set(pairs.map((p) => p.subjectId))];

  // Trois requêtes au total (celle-ci comprise), quel que soit le nombre de
  // couples. En boucle, une école de douze classes paierait vingt-quatre
  // allers-retours à chaque ouverture de la saisie.
  const [effectifs, notes] = await Promise.all([
    prisma.student.groupBy({
      by: ['classId'],
      where: { schoolId, classId: { in: classIds }, archivedAt: null },
      _count: { _all: true },
    }),
    // `distinct` porte la règle métier : un élève évalué compte une fois par
    // matière, quel que soit son nombre de notes. La classe vient de la même
    // lecture, ce qui évite une requête supplémentaire sur les élèves.
    prisma.grade.findMany({
      where: {
        schoolId,
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

  return pairs.map((pair) => ({
    assignmentId: pair.id,
    classId: pair.classId,
    className: pair.className,
    level: pair.level,
    subjectId: pair.subjectId,
    subjectName: pair.subjectName,
    effectif: effectifParClasse.get(pair.classId) ?? 0,
    evalues: evalues.get(`${pair.classId}:${pair.subjectId}`) ?? 0,
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
    throw badRequest("Cet élève n'est pas inscrit dans la classe concernée par cette évaluation.");
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
    throw conflict('Cet élève a déjà une note pour cette évaluation.', { gradeId: already.id });
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

  await recordAudit({
    schoolId: auth.schoolId,
    actorUserId: auth.userId,
    action: 'grade.updated',
    targetType: 'grade',
    targetId: grade.id,
    targetLabel: `${existing.student.firstName} ${existing.student.lastName}`,
    metadata: { oldValue: Number(existing.value), newValue: Number(grade.value) },
  });

  return toPublicGrade(grade);
}

export async function deleteGrade(auth: AuthPayload, id: number) {
  const grade = await findGradeForWrite(auth, id);
  await prisma.grade.delete({ where: { id } });

  await recordAudit({
    schoolId: auth.schoolId,
    actorUserId: auth.userId,
    action: 'grade.deleted',
    targetType: 'grade',
    targetId: id,
    targetLabel: `${grade.student.firstName} ${grade.student.lastName}`,
    metadata: { value: Number(grade.value) },
  });
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
    include: { student: { select: { classId: true, firstName: true, lastName: true } } },
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
 *
 * L'administration peut cependant rouvrir la période jusqu'à une échéance
 * (`reopened_until`) : la règle vit dans `term.service`, partagée avec la vue,
 * pour qu'un enseignant ne se voie jamais annoncer une période ouverte que
 * cette garde refuserait ensuite.
 */
export function assertTermWritable(
  auth: AuthPayload,
  term: { endDate: Date | null; reopenedUntil: Date | null },
) {
  if (auth.role === 'admin') return;
  if (isOpenForEntry(term)) return;

  throw forbidden(
    "Ce trimestre est terminé : la saisie n'est plus possible. Demandez à l'administration de rouvrir la période.",
  );
}

/** Charge la période et applique {@link assertTermWritable}. */
export async function assertTermOpen(auth: AuthPayload, termId: number) {
  const term = await prisma.term.findFirst({
    where: { id: termId, schoolId: auth.schoolId },
    select: { endDate: true, reopenedUntil: true },
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
  // Un type archivé est retiré des sélecteurs de saisie côté formulaire,
  // mais rien n'empêchait un appel direct à l'API de continuer à noter avec
  // — l'archivage n'a de sens que s'il est aussi garanti côté serveur.
  if (gradeType.archivedAt) {
    throw conflict('Ce type de note est archivé : restaurez-le avant de saisir de nouvelles notes.');
  }
}

function assertValueInRange(value: number, maxValue: number) {
  if (maxValue <= 0) throw badRequest('Le barème doit être supérieur à zéro.');
  if (value < 0 || value > maxValue) {
    throw badRequest(`La note doit être comprise entre 0 et ${maxValue}.`, { value, maxValue });
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
