import { Prisma } from '../../generated/prisma/client';

import prisma from '../../lib/prisma';
import { notFound } from '../../errors/AppError';
import {
  type GradeInput,
  generalAverage,
  serializeAverage,
  subjectAverage,
} from './compute';

const Decimal = Prisma.Decimal;
type D = Prisma.Decimal;

export interface SubjectResult {
  subjectId: number;
  subjectName: string;
  coefficient: number;
  average: number | null;
  /** Détail par catégorie : c'est la pièce que les parents contestent. */
  categories: { gradeTypeId: number; label: string; weight: number; average: number | null }[];
}

export interface StudentResult {
  studentId: number;
  firstName: string;
  lastName: string;
  average: number | null;
  subjects: SubjectResult[];
}

/**
 * Bulletin d'une classe pour une période.
 *
 * Nombre de requêtes constant, quel que soit l'effectif : charger les notes
 * élève par élève et matière par matière produirait ~1 000 requêtes pour une
 * classe de 40 élèves et 12 matières. Le calcul se fait ensuite en mémoire,
 * avec les fonctions pures de `compute.ts`.
 */
export async function computeClassBulletin(schoolId: number, classId: number, termId: number) {
  const [[bulletin], readiness] = await Promise.all([
    computeClassBulletins(schoolId, [classId], termId),
    computeBulletinReadiness(schoolId, classId, termId),
  ]);
  if (!bulletin) throw notFound('Classe introuvable');
  return { ...bulletin, bulletinReady: readiness.ready, missingSubjects: readiness.missingSubjects };
}

/**
 * Matières attendues d'une classe : celles qui ont un enseignant affecté ou
 * un coefficient déclaré (même définition que `grade.service.ts::listSchoolPairs`
 * et `ClassSubjectsPanel.tsx` côté front), sans dépendre de ce qui a déjà été
 * noté.
 */
async function listExpectedSubjects(
  schoolId: number,
  classId: number,
): Promise<{ id: number; name: string }[]> {
  const [assignments, coefficients] = await Promise.all([
    prisma.teacherAssignment.findMany({
      where: { schoolId, classId },
      select: { subjectId: true, subject: { select: { name: true } } },
    }),
    prisma.subjectCoefficient.findMany({
      where: { classId, subject: { schoolId } },
      select: { subjectId: true, subject: { select: { name: true } } },
    }),
  ]);

  const seen = new Map<number, string>();
  for (const a of assignments) seen.set(a.subjectId, a.subject.name);
  for (const c of coefficients) seen.set(c.subjectId, c.subject.name);

  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Un bulletin n'est « prêt » — au sens où il peut être remis aux familles —
 * que lorsque chaque matière attendue de la classe a produit au moins une
 * note sur la période. Avant ça, le document aurait des colonnes manquantes
 * plutôt que des tirets isolés : mieux vaut ne pas l'offrir du tout.
 *
 * Une classe sans aucune matière attendue (mode présence, ou pas encore
 * configurée) n'est jamais « prête » : il n'y a rien à couvrir, donc rien à
 * remettre.
 */
export async function computeBulletinReadiness(
  schoolId: number,
  classId: number,
  termId: number,
): Promise<{ ready: boolean; missingSubjects: string[] }> {
  const [expected, graded] = await Promise.all([
    listExpectedSubjects(schoolId, classId),
    prisma.grade.findMany({
      where: { schoolId, termId, student: { classId, archivedAt: null } },
      distinct: ['subjectId'],
      select: { subjectId: true },
    }),
  ]);

  if (expected.length === 0) return { ready: false, missingSubjects: [] };

  const gradedIds = new Set(graded.map((g) => g.subjectId));
  const missingSubjects = expected.filter((s) => !gradedIds.has(s.id)).map((s) => s.name);

  return { ready: missingSubjects.length === 0, missingSubjects };
}

/**
 * Bulletins de plusieurs classes en **cinq requêtes**, que l'on en demande une
 * ou trente : période, classes, élèves, notes, coefficients.
 *
 * Appeler cette fonction en boucle sur 30 classes en ferait 150 : c'est le
 * tableau de bord de l'administration qui les paierait, à chaque chargement de
 * sa page d'accueil.
 */
export async function computeClassBulletins(
  schoolId: number,
  classIds: number[],
  termId: number,
) {
  const term = await prisma.term.findFirst({ where: { id: termId, schoolId } });
  if (!term) throw notFound('Période introuvable');

  const [classes, allStudents, allGrades, allCoefficients] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: classIds }, schoolId } }),
    prisma.student.findMany({
      where: { classId: { in: classIds }, schoolId, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, classId: true, firstName: true, lastName: true },
    }),
    prisma.grade.findMany({
      // Ancrée à `evaluation.classId`, jamais à `student.classId` : une note
      // reste attachée à la classe où elle a été saisie, pas à la classe
      // courante de l'élève (voir le commentaire de Grade dans schema.prisma).
      // Un élève déplacé en cours de période ne doit ni perdre son historique
      // dans son ancienne classe, ni le voir apparaître à tort dans la
      // nouvelle.
      where: { schoolId, termId, student: { archivedAt: null }, evaluation: { classId: { in: classIds } } },
      select: {
        studentId: true,
        subjectId: true,
        gradeTypeId: true,
        value: true,
        maxValue: true,
        evaluation: { select: { classId: true } },
        gradeType: { select: { id: true, code: true, label: true, weight: true, position: true } },
        subject: { select: { id: true, name: true, coefficient: true } },
      },
    }),
    prisma.subjectCoefficient.findMany({ where: { classId: { in: classIds } } }),
  ]);

  return classes.map((klass) =>
    buildBulletin(
      klass,
      term,
      allStudents.filter((s) => s.classId === klass.id),
      allGrades.filter((g) => g.evaluation.classId === klass.id),
      allCoefficients.filter((c) => c.classId === klass.id),
    ),
  );
}

/**
 * Rang de l'élève dans sa classe sur une période — même tri que
 * `class.service.ts::getClassDetail` (nulls en fin de classement, égalité
 * départagée par nom) pour que le rang annoncé au parent corresponde
 * exactement à celui vu côté classe. Ne renvoie qu'un nombre : jamais les
 * autres élèves, qui n'ont pas à être exposés au parent.
 */
export async function computeStudentRank(
  schoolId: number,
  studentId: number,
  classId: number,
  termId: number,
): Promise<{ position: number; total: number } | null> {
  const bulletin = await computeClassBulletin(schoolId, classId, termId);

  const ranked = [...bulletin.students].sort((a, b) => {
    if (a.average === null && b.average === null) return a.lastName.localeCompare(b.lastName, 'fr');
    if (a.average === null) return 1;
    if (b.average === null) return -1;
    return b.average - a.average;
  });
  const noted = ranked.filter((s) => s.average !== null);

  const position = noted.findIndex((s) => s.studentId === studentId);
  return position === -1 ? null : { position: position + 1, total: noted.length };
}

function buildBulletin(
  klass: { id: number; name: string; level: string },
  term: { id: number; label: string },
  students: { id: number; firstName: string; lastName: string }[],
  grades: {
    studentId: number;
    subjectId: number;
    gradeTypeId: number;
    value: D;
    maxValue: D;
    gradeType: { id: number; code: string; label: string; weight: D; position: number };
    subject: { id: number; name: string; coefficient: D | null };
  }[],
  coefficients: { subjectId: number; coefficient: D }[],
) {
  const classId = klass.id;
  const termId = term.id;

  const coefficientBySubject = new Map(coefficients.map((c) => [c.subjectId, c.coefficient]));

  // Matières effectivement notées dans cette classe sur la période.
  const subjectMeta = new Map<number, { name: string; coefficient: D; position: number }>();
  for (const grade of grades) {
    if (!subjectMeta.has(grade.subjectId)) {
      subjectMeta.set(grade.subjectId, {
        name: grade.subject.name,
        coefficient:
          coefficientBySubject.get(grade.subjectId) ??
          grade.subject.coefficient ??
          new Decimal(1),
        position: 0,
      });
    }
  }

  const gradesByStudent = new Map<number, typeof grades>();
  for (const grade of grades) {
    const list = gradesByStudent.get(grade.studentId) ?? [];
    list.push(grade);
    gradesByStudent.set(grade.studentId, list);
  }

  // Moyenne générale en pleine précision, gardée à part de `results` (qui ne
  // porte que la version arrondie, seule destinée au JSON) : moyenner des
  // moyennes déjà arrondies à 2 décimales dériverait jusqu'à ±0,005 par
  // élève avant l'arrondi final de `classAverage` — exactement ce que la
  // discipline « Decimal de bout en bout » du module cherche à éviter.
  const rawAverages: (D | null)[] = [];

  const results: StudentResult[] = students.map((student) => {
    const studentGrades = gradesByStudent.get(student.id) ?? [];

    const bySubject = new Map<number, typeof grades>();
    for (const grade of studentGrades) {
      const list = bySubject.get(grade.subjectId) ?? [];
      list.push(grade);
      bySubject.set(grade.subjectId, list);
    }

    const subjects: SubjectResult[] = [];
    const forGeneral: { average: D; coefficient: D }[] = [];

    for (const [subjectId, meta] of subjectMeta) {
      const subjectGrades = bySubject.get(subjectId) ?? [];
      const average = subjectAverage(subjectGrades.map(toGradeInput));

      if (average !== null) forGeneral.push({ average, coefficient: meta.coefficient });

      subjects.push({
        subjectId,
        subjectName: meta.name,
        coefficient: Number(meta.coefficient),
        average: serializeAverage(average),
        categories: categoriesOf(subjectGrades),
      });
    }

    subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName, 'fr'));

    const generalAvg = generalAverage(forGeneral);
    rawAverages.push(generalAvg);

    return {
      studentId: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      average: serializeAverage(generalAvg),
      subjects,
    };
  });

  return {
    classId,
    className: klass.name,
    level: klass.level,
    termId,
    termLabel: term.label,
    students: results,
    classAverage: serializeAverage(averageOfDecimals(rawAverages)),
    /**
     * Moyennes générales en pleine précision, dans l'ordre de `students` —
     * réservé au calcul de la moyenne d'école sur plusieurs classes
     * (`dashboard.service.ts`). Jamais renvoyé tel quel en JSON : tout appelant
     * qui étale ce bulletin dans une réponse HTTP doit l'exclure explicitement.
     */
    studentRawAverages: rawAverages,
  };
}

/**
 * Notes, moyennes par matière et moyenne générale (pleine précision) d'un
 * élève sur une période — cœur partagé par `computeStudentResult` (un seul
 * terme, arrondi à la sérialisation) et `computeAnnualAverage` (plusieurs
 * termes de la même année scolaire, moyennés avant tout arrondi).
 */
async function studentSubjectsAndAverage(
  schoolId: number,
  studentId: number,
  classId: number,
  termId: number,
): Promise<{ subjects: SubjectResult[]; rawAverage: D | null }> {
  const [grades, coefficients] = await Promise.all([
    prisma.grade.findMany({
      where: { schoolId, studentId, termId },
      select: {
        studentId: true,
        subjectId: true,
        gradeTypeId: true,
        value: true,
        maxValue: true,
        gradeType: { select: { id: true, code: true, label: true, weight: true, position: true } },
        subject: { select: { id: true, name: true, coefficient: true } },
      },
    }),
    prisma.subjectCoefficient.findMany({ where: { classId } }),
  ]);

  const coefficientBySubject = new Map(coefficients.map((c) => [c.subjectId, c.coefficient]));

  const bySubject = new Map<number, typeof grades>();
  for (const grade of grades) {
    const list = bySubject.get(grade.subjectId) ?? [];
    list.push(grade);
    bySubject.set(grade.subjectId, list);
  }

  const subjects: SubjectResult[] = [];
  const forGeneral: { average: D; coefficient: D }[] = [];

  for (const [subjectId, subjectGrades] of bySubject) {
    const first = subjectGrades[0];
    if (!first) continue;

    const coefficient =
      coefficientBySubject.get(subjectId) ?? first.subject.coefficient ?? new Decimal(1);
    const average = subjectAverage(subjectGrades.map(toGradeInput));

    if (average !== null) forGeneral.push({ average, coefficient });

    subjects.push({
      subjectId,
      subjectName: first.subject.name,
      coefficient: Number(coefficient),
      average: serializeAverage(average),
      categories: categoriesOf(subjectGrades),
    });
  }

  subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName, 'fr'));

  return { subjects, rawAverage: generalAverage(forGeneral) };
}

/** Résultats d'un élève sur une période (espace parent, détail classe). */
export async function computeStudentResult(
  schoolId: number,
  studentId: number,
  termId: number,
): Promise<StudentResult> {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, firstName: true, lastName: true, classId: true, archivedAt: true },
  });
  if (!student) throw notFound('Élève introuvable');

  const { subjects, rawAverage } = await studentSubjectsAndAverage(
    schoolId,
    studentId,
    student.classId,
    termId,
  );

  return {
    studentId: student.id,
    firstName: student.firstName,
    lastName: student.lastName,
    average: serializeAverage(rawAverage),
    subjects,
  };
}

/**
 * Moyenne annuelle : moyenne simple des moyennes générales (pleine
 * précision) de chaque période active de l'année scolaire — même discipline
 * que la moyenne de classe (`averageOfDecimals`) pour éviter de dériver en
 * moyennant des moyennes déjà arrondies à 2 décimales. Une période sans
 * moyenne (élève pas encore noté ce terme-là) est simplement absente du
 * calcul, jamais comptée 0. `null` si l'année scolaire n'a aucune période
 * active.
 */
export async function computeAnnualAverage(
  schoolId: number,
  studentId: number,
  schoolYearId: number,
): Promise<number | null> {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, classId: true },
  });
  if (!student) throw notFound('Élève introuvable');

  const terms = await prisma.term.findMany({
    where: { schoolId, schoolYearId, archivedAt: null },
    select: { id: true },
  });
  if (terms.length === 0) return null;

  const rawAverages = await Promise.all(
    terms.map((term) =>
      studentSubjectsAndAverage(schoolId, studentId, student.classId, term.id).then(
        (r) => r.rawAverage,
      ),
    ),
  );

  return serializeAverage(averageOfDecimals(rawAverages));
}

/**
 * Moyenne générale de chaque période active de l'année scolaire, dans
 * l'ordre chronologique — la « tendance » côté parent, adaptée à notre
 * découpage par trimestre plutôt qu'au mensuel qui ne correspond à rien dans
 * ce modèle. Un seul point (ou aucun) n'est pas une tendance : c'est au
 * client de décider s'il affiche quelque chose en dessous de deux.
 */
export async function computeTermTrend(
  schoolId: number,
  studentId: number,
  schoolYearId: number,
): Promise<{ termId: number; termLabel: string; average: number | null }[]> {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, classId: true },
  });
  if (!student) throw notFound('Élève introuvable');

  const terms = await prisma.term.findMany({
    where: { schoolId, schoolYearId, archivedAt: null },
    orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: { id: true, label: true },
  });

  return Promise.all(
    terms.map(async (term) => {
      const { rawAverage } = await studentSubjectsAndAverage(schoolId, studentId, student.classId, term.id);
      return { termId: term.id, termLabel: term.label, average: serializeAverage(rawAverage) };
    }),
  );
}

export interface AnnualStudentResult {
  studentId: number;
  firstName: string;
  lastName: string;
  /** Moyenne générale de chaque période active de l'année, dans l'ordre de `terms`. */
  termAverages: (number | null)[];
  /** Moyenne annuelle — moyenne des moyennes brutes de chaque période, voir `computeAnnualAverage`. */
  average: number | null;
}

/**
 * Bulletin annuel cumulé d'une classe : une ligne par élève, une colonne par
 * période active de l'année scolaire, plus la moyenne annuelle — même
 * discipline « Decimal de bout en bout » que `computeAnnualAverage`, étendue
 * à toute la classe en un seul calcul plutôt qu'élève par élève (ce qui
 * ferait autant de requêtes que d'élèves × périodes).
 *
 * `terms.length === 0` (année sans période active) : bulletin jamais prêt,
 * `missingByTerm` vide — rien à réclamer, juste rien à calculer.
 */
export async function computeAnnualClassBulletin(
  schoolId: number,
  classId: number,
  schoolYearId: number,
) {
  const [klass, schoolYear] = await Promise.all([
    prisma.class.findFirst({ where: { id: classId, schoolId } }),
    prisma.schoolYear.findFirst({ where: { id: schoolYearId, schoolId } }),
  ]);
  if (!klass) throw notFound('Classe introuvable');
  if (!schoolYear) throw notFound('Année scolaire introuvable');

  const terms = await prisma.term.findMany({
    where: { schoolId, schoolYearId, archivedAt: null },
    orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: { id: true, label: true },
  });

  const base = {
    classId,
    className: klass.name,
    level: klass.level,
    schoolYearId,
    schoolYearLabel: schoolYear.label,
    terms,
  };

  if (terms.length === 0) {
    return {
      ...base,
      students: [] as AnnualStudentResult[],
      classAverage: null,
      bulletinReady: false,
      missingByTerm: [] as { termLabel: string; subjects: string[] }[],
    };
  }

  const [bulletinsByTerm, readinessByTerm] = await Promise.all([
    Promise.all(terms.map((term) => computeClassBulletins(schoolId, [classId], term.id).then((r) => r[0]))),
    Promise.all(terms.map((term) => computeBulletinReadiness(schoolId, classId, term.id))),
  ]);

  // Effectif courant de la classe, indépendant de la période (voir
  // `computeClassBulletins` : filtré par `classId` actuel, jamais par
  // historique) — identique quel que soit le terme d'où on le lit.
  const roster = bulletinsByTerm[0]?.students ?? [];

  const rawAnnualAverages: (D | null)[] = [];

  const students: AnnualStudentResult[] = roster.map((student) => {
    const termAverages: (number | null)[] = [];
    const rawPerTerm: (D | null)[] = [];

    for (const bulletin of bulletinsByTerm) {
      const index = bulletin?.students.findIndex((s) => s.studentId === student.studentId) ?? -1;
      if (!bulletin || index === -1) {
        termAverages.push(null);
        rawPerTerm.push(null);
        continue;
      }
      termAverages.push(bulletin.students[index]!.average);
      rawPerTerm.push(bulletin.studentRawAverages[index] ?? null);
    }

    const rawAnnual = averageOfDecimals(rawPerTerm);
    rawAnnualAverages.push(rawAnnual);

    return {
      studentId: student.studentId,
      firstName: student.firstName,
      lastName: student.lastName,
      termAverages,
      average: serializeAverage(rawAnnual),
    };
  });

  const missingByTerm = terms
    .map((term, index) => ({ termLabel: term.label, subjects: readinessByTerm[index]!.missingSubjects }))
    .filter((entry) => entry.subjects.length > 0);

  return {
    ...base,
    students,
    classAverage: serializeAverage(averageOfDecimals(rawAnnualAverages)),
    bulletinReady: readinessByTerm.every((r) => r.ready),
    missingByTerm,
  };
}

/**
 * Signale un doublon probable : même élève, matière, type et période, saisis
 * le même jour. Non bloquant — plusieurs interrogations le même jour sont
 * légitimes — mais une composition saisie deux fois décale la moyenne sans
 * que personne ne le voie.
 */
export async function checkDuplicateWarning(input: {
  schoolId: number;
  studentId: number;
  subjectId: number;
  gradeTypeId: number;
  termId: number;
  excludeGradeId?: number;
}): Promise<boolean> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date();
  dayEnd.setHours(23, 59, 59, 999);

  const { excludeGradeId, ...where } = input;

  const count = await prisma.grade.count({
    where: {
      ...where,
      createdAt: { gte: dayStart, lte: dayEnd },
      ...(excludeGradeId ? { id: { not: excludeGradeId } } : {}),
    },
  });

  return count > 0;
}

function toGradeInput(grade: {
  gradeTypeId: number;
  value: D;
  maxValue: D;
  gradeType: { code: string; weight: D };
}): GradeInput {
  return {
    gradeTypeId: grade.gradeTypeId,
    code: grade.gradeType.code,
    weight: grade.gradeType.weight,
    value: grade.value,
    maxValue: grade.maxValue,
  };
}

function categoriesOf(
  grades: {
    gradeTypeId: number;
    value: D;
    maxValue: D;
    gradeType: { id: number; label: string; weight: D; position: number };
  }[],
) {
  const byType = new Map<number, { label: string; weight: D; position: number; values: D[] }>();

  for (const grade of grades) {
    const entry = byType.get(grade.gradeTypeId) ?? {
      label: grade.gradeType.label,
      weight: grade.gradeType.weight,
      position: grade.gradeType.position,
      values: [],
    };
    entry.values.push(grade.value.div(grade.maxValue).mul(20));
    byType.set(grade.gradeTypeId, entry);
  }

  return [...byType.entries()]
    .sort((a, b) => a[1].position - b[1].position)
    .map(([gradeTypeId, entry]) => ({
      gradeTypeId,
      label: entry.label,
      weight: Number(entry.weight),
      average: serializeAverage(
        entry.values.reduce((sum, v) => sum.add(v), new Decimal(0)).div(entry.values.length),
      ),
    }));
}

/**
 * Moyenne de classe : moyenne des moyennes générales (pleine précision) des
 * élèves qui ont au moins une note. Un élève sans note n'est ni exclu de la
 * classe ni compté 0, il est simplement absent du calcul.
 */
function averageOfDecimals(values: (D | null)[]): D | null {
  const present = values.filter((v): v is D => v !== null);
  if (present.length === 0) return null;

  return present.reduce((sum, v) => sum.add(v), new Decimal(0)).div(present.length);
}
