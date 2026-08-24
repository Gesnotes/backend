import 'dotenv/config';

import argon2 from 'argon2';

import prisma from '../src/lib/prisma';
import { normalizeEmail, normalizePhone } from '../src/lib/normalize';

/**
 * Jeu de démonstration complet — École de la Lumière.
 *
 * Le seed de base (`seed.ts`) crée le strict nécessaire au démarrage : une
 * école, un admin, les types de note et les périodes. Il ne permet pas de
 * *tester* l'application, où chaque écran suppose des classes, des élèves
 * notés et des familles rattachées.
 *
 * Ce script produit donc un établissement plausible et complet :
 *   8 classes · 8 matières · 5 enseignants affectés · 40 élèves
 *   parents rattachés · notes réparties sur les trois trimestres
 *
 * Idempotent : relançable sans dupliquer quoi que ce soit. Les notes sont
 * déterministes (générateur pseudo-aléatoire à graine fixe), pour qu'une
 * capture d'écran ou un test de non-régression restent comparables.
 *
 *   npm run prisma:seed:demo
 */

const SCHOOL_NAME = 'École de la Lumière';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'demo1234';

/** Générateur déterministe : mêmes notes à chaque exécution. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
const random = makeRandom(20262027);

function pickGrade(base: number, spread: number): number {
  const raw = base + (random() * 2 - 1) * spread;
  // Quarts de point : c'est la granularité réelle des copies corrigées.
  return Math.max(0, Math.min(20, Math.round(raw * 4) / 4));
}

const CLASSES = [
  { name: '6e A', level: '6e', base: 12.4 },
  { name: '6e B', level: '6e', base: 11.8 },
  { name: '5e A', level: '5e', base: 12.9 },
  { name: '4e A', level: '4e', base: 11.2 },
  { name: '3e A', level: '3e', base: 13.1 },
  { name: '2nde C', level: '2nde', base: 10.7 },
  { name: '1ere D', level: '1ere', base: 12.2 },
  { name: 'Tle D', level: 'Tle', base: 11.9 },
];

const SUBJECTS = [
  { name: 'Mathématiques', coefficient: 5 },
  { name: 'PCT', coefficient: 4 },
  { name: 'SVT', coefficient: 3 },
  { name: 'Français', coefficient: 4 },
  { name: 'Anglais', coefficient: 3 },
  { name: 'Histoire-Géographie', coefficient: 2 },
  { name: 'Philosophie', coefficient: 2 },
  { name: 'EPS', coefficient: 1 },
];

const TEACHERS = [
  { firstName: 'Rodrigue', lastName: 'Hounkpatin', subject: 'Mathématiques', classes: ['3e A', '4e A', '6e A'] },
  { firstName: 'Chimène', lastName: 'Agbodjan', subject: 'Français', classes: ['6e A', '6e B', '5e A'] },
  { firstName: 'Prince', lastName: 'Dossou', subject: 'PCT', classes: ['Tle D', '1ere D', '2nde C'] },
  { firstName: 'Nadège', lastName: 'Sossou', subject: 'SVT', classes: ['5e A', '3e A'] },
  { firstName: 'Firmin', lastName: 'Gbaguidi', subject: 'Anglais', classes: ['2nde C', '1ere D', 'Tle D'] },
];

const FIRST_NAMES = [
  'Adjovi', 'Bénédicta', 'Kossi', 'Landry', 'Mawuena', 'Odette', 'Sylvain', 'Viviane',
  'Rodrigue', 'Fifamè', 'Prince', 'Chimène', 'Nadège', 'Hervé', 'Reine', 'Bernard',
  'Georgette', 'Paul', 'Alice', 'Sylvie',
];

const LAST_NAMES = [
  'Ahouandjinou', 'Zinsou', 'Sagbo', 'Houngbédji', 'Aïtchédji', 'Tossou', 'Codjo', 'Djossou',
  'Tchané', 'Assogba', 'Dagba', 'Kpassassi', 'Ahoyo', 'Hounsou', 'Adjovi', 'Gbédji',
];

async function main() {
  const school =
    (await prisma.school.findFirst({ where: { name: SCHOOL_NAME } })) ??
    (await prisma.school.create({ data: { name: SCHOOL_NAME } }));

  const passwordHash = await argon2.hash(PASSWORD);

  // ------------------------------------------------------------- Comptes
  const admin = await upsertUser(school.id, {
    email: 'directrice@ecole-lumiere.bj',
    role: 'admin',
    firstName: 'Léonie',
    lastName: 'Codjo',
    phone: '+22997000001',
    passwordHash,
  });

  // ------------------------------------------------------- Types de note
  const gradeTypeSpecs = [
    { code: 'interrogation', label: 'Interrogation', weight: 1, position: 1 },
    { code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
    { code: 'composition', label: 'Composition', weight: 3, position: 3 },
  ];
  const gradeTypes = [];
  for (const spec of gradeTypeSpecs) {
    gradeTypes.push(
      await prisma.gradeType.upsert({
        where: { schoolId_code: { schoolId: school.id, code: spec.code } },
        update: { label: spec.label, weight: spec.weight, position: spec.position },
        create: { schoolId: school.id, ...spec },
      }),
    );
  }

  // ------------------------------------------------------------ Périodes
  const today = new Date();
  const y = today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1;
  const termSpecs = [
    { label: 'Trimestre 1', startDate: `${y}-09-01`, endDate: `${y}-12-20` },
    { label: 'Trimestre 2', startDate: `${y + 1}-01-05`, endDate: `${y + 1}-03-31` },
    { label: 'Trimestre 3', startDate: `${y + 1}-04-01`, endDate: `${y + 1}-06-30` },
  ];
  const terms = [];
  for (const spec of termSpecs) {
    terms.push(
      await upsertBy(
        () => prisma.term.findFirst({ where: { schoolId: school.id, label: spec.label } }),
        (id) =>
          prisma.term.update({
            where: { id },
            data: { startDate: new Date(spec.startDate), endDate: new Date(spec.endDate) },
          }),
        () =>
          prisma.term.create({
            data: {
              schoolId: school.id,
              label: spec.label,
              startDate: new Date(spec.startDate),
              endDate: new Date(spec.endDate),
            },
          }),
      ),
    );
  }

  // ------------------------------------------------------------- Classes
  const classes = [];
  for (const spec of CLASSES) {
    classes.push(
      await upsertBy(
        () => prisma.class.findFirst({ where: { schoolId: school.id, name: spec.name } }),
        (id) => prisma.class.update({ where: { id }, data: { level: spec.level } }),
        () =>
          prisma.class.create({
            data: { schoolId: school.id, name: spec.name, level: spec.level },
          }),
      ),
    );
  }
  const classByName = new Map(classes.map((c) => [c.name, c]));

  // ------------------------------------------------------------ Matières
  const subjects = [];
  for (const spec of SUBJECTS) {
    subjects.push(
      await upsertBy(
        () => prisma.subject.findFirst({ where: { schoolId: school.id, name: spec.name } }),
        (id) => prisma.subject.update({ where: { id }, data: { coefficient: spec.coefficient } }),
        () =>
          prisma.subject.create({
            data: { schoolId: school.id, name: spec.name, coefficient: spec.coefficient },
          }),
      ),
    );
  }
  const subjectByName = new Map(subjects.map((s) => [s.name, s]));

  /**
   * Coefficients par classe pour le second cycle : la philosophie y pèse
   * davantage qu'en sixième, où elle n'est pas enseignée. Ce sont ces
   * surcharges que l'écran « Matières » affiche.
   */
  for (const className of ['2nde C', '1ere D', 'Tle D']) {
    const klass = classByName.get(className);
    const philo = subjectByName.get('Philosophie');
    if (!klass || !philo) continue;
    await prisma.subjectCoefficient.upsert({
      where: { subjectId_classId: { subjectId: philo.id, classId: klass.id } },
      update: { coefficient: 4 },
      create: { subjectId: philo.id, classId: klass.id, coefficient: 4 },
    });
  }

  // --------------------------------------------------------- Enseignants
  const teacherUsers = [];
  for (const spec of TEACHERS) {
    const user = await upsertUser(school.id, {
      email: `${slug(spec.firstName).slice(0, 1)}.${slug(spec.lastName)}@ecole-lumiere.bj`,
      role: 'teacher',
      firstName: spec.firstName,
      lastName: spec.lastName,
      passwordHash,
    });
    teacherUsers.push({ user, spec });

    const subject = subjectByName.get(spec.subject);
    if (!subject) continue;

    for (const className of spec.classes) {
      const klass = classByName.get(className);
      if (!klass) continue;
      await prisma.teacherAssignment.upsert({
        where: {
          teacherUserId_classId_subjectId: {
            teacherUserId: user.id,
            classId: klass.id,
            subjectId: subject.id,
          },
        },
        update: {},
        create: {
          schoolId: school.id,
          teacherUserId: user.id,
          classId: klass.id,
          subjectId: subject.id,
        },
      });
    }
  }

  // ---------------------------------------------------- Élèves et parents
  let studentCount = 0;
  let parentCount = 0;
  const students: { id: number; classId: number; className: string }[] = [];

  for (const [classIndex, klass] of classes.entries()) {
    // Cinq élèves par classe : assez pour un classement lisible, assez peu
    // pour que le seed reste rapide.
    for (let i = 0; i < 5; i += 1) {
      const firstName = FIRST_NAMES[(classIndex * 5 + i) % FIRST_NAMES.length] as string;
      const lastName = LAST_NAMES[(classIndex * 3 + i) % LAST_NAMES.length] as string;

      const student = await upsertBy(
        () =>
          prisma.student.findFirst({
            where: { schoolId: school.id, classId: klass.id, firstName, lastName },
          }),
        (id) => prisma.student.update({ where: { id }, data: { classId: klass.id } }),
        () =>
          prisma.student.create({
            data: { schoolId: school.id, classId: klass.id, firstName, lastName },
          }),
      );
      students.push({ id: student.id, classId: klass.id, className: klass.name });
      studentCount += 1;

      /**
       * Un élève sur cinq reste sans parent associé : c'est l'anomalie que
       * l'écran « Élèves » doit rendre visible, et elle n'apparaîtrait pas
       * dans un jeu de données parfait.
       */
      if (i === 4) continue;

      const parent = await upsertUser(school.id, {
        email: `parent.${slug(lastName)}.${student.id}@famille.bj`,
        role: 'parent',
        firstName: i % 2 === 0 ? 'Sylvie' : 'Bernard',
        lastName,
        phone: `+2299700${String(1000 + student.id).slice(-4)}`,
        passwordHash,
      });
      parentCount += 1;

      await prisma.studentParent.upsert({
        where: { studentId_parentUserId: { studentId: student.id, parentUserId: parent.id } },
        update: {},
        create: { schoolId: school.id, studentId: student.id, parentUserId: parent.id },
      });
    }
  }

  // ---------------------------------------------------------------- Notes
  let gradeCount = 0;

  for (const { user, spec } of teacherUsers) {
    const subject = subjectByName.get(spec.subject);
    if (!subject) continue;

    for (const className of spec.classes) {
      const klass = classByName.get(className);
      if (!klass) continue;

      const classBase = CLASSES.find((c) => c.name === className)?.base ?? 12;
      const classStudents = students.filter((s) => s.classId === klass.id);

      for (const [termIndex, term] of terms.entries()) {
        /**
         * Le troisième trimestre n'est volontairement pas noté partout, et
         * une classe reste entièrement vierge : sans cela, l'avancement de la
         * saisie afficherait 100 % partout et l'écran perdrait tout son sens.
         */
        if (termIndex === 2 && className !== '3e A') continue;
        if (className === 'Tle D' && termIndex > 0) continue;

        for (const gradeType of gradeTypes) {
          // Pas de composition au troisième trimestre : elle n'a pas eu lieu.
          if (termIndex === 2 && gradeType.code === 'composition') continue;

          // Une évaluation par (classe, matière, type, période) : les notes de
          // la démo s'y rattachent. Idempotent comme le reste du seed.
          const evaluation =
            (await prisma.evaluation.findFirst({
              where: {
                schoolId: school.id,
                classId: klass.id,
                subjectId: subject.id,
                gradeTypeId: gradeType.id,
                termId: term.id,
              },
            })) ??
            (await prisma.evaluation.create({
              data: {
                schoolId: school.id,
                classId: klass.id,
                subjectId: subject.id,
                gradeTypeId: gradeType.id,
                termId: term.id,
                teacherUserId: user.id,
                label: gradeType.label,
                maxValue: 20,
              },
            }));

          for (const student of classStudents) {
            const existing = await prisma.grade.findUnique({
              where: {
                evaluationId_studentId: { evaluationId: evaluation.id, studentId: student.id },
              },
              select: { id: true },
            });
            if (existing) continue;

            const value = pickGrade(classBase, 4);
            await prisma.grade.create({
              data: {
                schoolId: school.id,
                studentId: student.id,
                evaluationId: evaluation.id,
                subjectId: subject.id,
                gradeTypeId: gradeType.id,
                termId: term.id,
                teacherUserId: user.id,
                value,
                maxValue: 20,
                comment:
                  gradeType.code === 'composition' && value >= 14
                    ? 'Très bon trimestre, raisonnement solide. Continuez ainsi.'
                    : gradeType.code === 'composition' && value < 10
                      ? 'Des efforts à fournir, notamment sur les exercices d’application.'
                      : null,
              },
            });
            gradeCount += 1;
          }
        }
      }
    }
  }

  console.log('');
  console.log(`École        : ${school.name} (#${school.id})`);
  console.log(`Admin        : ${admin.email} / ${PASSWORD}`);
  console.log(`Enseignant   : ${teacherUsers[0]?.user.email} / ${PASSWORD}`);
  console.log(`Parent       : voir la liste ci-dessous / ${PASSWORD}`);
  console.log('');
  console.log(`Classes      : ${classes.length}`);
  console.log(`Matières     : ${subjects.length}`);
  console.log(`Enseignants  : ${teacherUsers.length}`);
  console.log(`Élèves       : ${studentCount} (dont ${studentCount - parentCount} sans parent)`);
  console.log(`Parents      : ${parentCount}`);
  console.log(`Notes créées : ${gradeCount}`);
  console.log('');

  const sampleParent = await prisma.user.findFirst({
    where: { schoolId: school.id, role: 'parent' },
    orderBy: { id: 'asc' },
    select: { email: true },
  });
  console.log(`Exemple parent : ${sampleParent?.email}`);
}

/** `upsert` par critère non unique : Prisma l'exige sur un index. */
async function upsertBy<T>(
  find: () => Promise<{ id: number } | null>,
  update: (id: number) => Promise<T>,
  create: () => Promise<T>,
): Promise<T> {
  const existing = await find();
  return existing ? update(existing.id) : create();
}

async function upsertUser(
  schoolId: number,
  data: {
    email: string;
    role: 'admin' | 'teacher' | 'parent';
    firstName: string;
    lastName: string;
    phone?: string;
    passwordHash: string;
  },
) {
  const email = normalizeEmail(data.email);
  return prisma.user.upsert({
    where: { schoolId_email: { schoolId, email } },
    update: { firstName: data.firstName, lastName: data.lastName },
    create: {
      schoolId,
      email,
      phone: data.phone ? normalizePhone(data.phone) : null,
      role: data.role,
      passwordHash: data.passwordHash,
      firstName: data.firstName,
      lastName: data.lastName,
    },
  });
}

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
