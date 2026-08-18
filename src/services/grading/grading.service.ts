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
  const [bulletin] = await computeClassBulletins(schoolId, [classId], termId);
  if (!bulletin) throw notFound('Classe introuvable');
  return bulletin;
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
