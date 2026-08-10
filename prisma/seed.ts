import 'dotenv/config';

import argon2 from 'argon2';

import prisma from '../src/lib/prisma';
import { normalizeEmail } from '../src/lib/normalize';

/**
 * Seed minimal de développement : une école, un compte admin, et les trois
 * types de note par défaut.
 *
 * Les poids (interrogation 1, devoir 2, composition 3) sont semés par école et
 * non codés en dur : une école qui pondère différemment se configure sans
 * redéploiement.
 *
 * Idempotent : relançable sans dupliquer de données.
 */
async function main() {
  const school =
    (await prisma.school.findFirst({ where: { name: 'École de démonstration' } })) ??
    (await prisma.school.create({ data: { name: 'École de démonstration' } }));

  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234';
  const passwordHash = await argon2.hash(adminPassword);

  /**
   * Un compte par rôle.
   *
   * L'admin seul ne permettait pas de parcourir l'application : les espaces
   * enseignant et parent sont inaccessibles sans compte du rôle correspondant,
   * et les comptes créés depuis l'interface le sont par invitation, donc sans
   * mot de passe utilisable. Il fallait passer par la base pour les essayer.
   */
  const admin = await upsertUser(school.id, {
    email: 'admin@ecole-demo.test',
    role: 'admin',
    firstName: 'Admin',
    lastName: 'Démo',
    passwordHash,
  });

  const teacher = await upsertUser(school.id, {
    email: 'prof@ecole-demo.test',
    role: 'teacher',
    firstName: 'Prof',
    lastName: 'Démo',
    passwordHash,
  });

  const parent = await upsertUser(school.id, {
    email: 'parent@ecole-demo.test',
    role: 'parent',
    firstName: 'Parent',
    lastName: 'Démo',
    passwordHash,
  });

  const gradeTypes = [
    { code: 'interrogation', label: 'Interrogation', weight: 1, position: 1 },
    { code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
    { code: 'composition', label: 'Composition', weight: 3, position: 3 },
  ];

  for (const gradeType of gradeTypes) {
    await prisma.gradeType.upsert({
      where: { schoolId_code: { schoolId: school.id, code: gradeType.code } },
      update: { label: gradeType.label, weight: gradeType.weight, position: gradeType.position },
      create: { schoolId: school.id, ...gradeType },
    });
  }

  /**
   * Année scolaire et trois trimestres.
   *
   * Sans période, une base fraîchement seedée est inutilisable : `term_id` est
   * exigé par le détail de classe, le bulletin et la fiche enfant, et rien ne
   * permettait d'en découvrir une. L'année est calée sur septembre — celle en
   * cours si l'on est après le 1er août, la précédente sinon.
   */
  const today = new Date();
  const startYear = today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1;

  const terms = [
    { label: `Trimestre 1`, startDate: `${startYear}-09-01`, endDate: `${startYear}-12-20` },
    { label: `Trimestre 2`, startDate: `${startYear + 1}-01-05`, endDate: `${startYear + 1}-03-31` },
    { label: `Trimestre 3`, startDate: `${startYear + 1}-04-01`, endDate: `${startYear + 1}-06-30` },
  ];

  for (const term of terms) {
    // `Term` n'a pas de contrainte d'unicité exploitable par `upsert` : on
    // recherche par libellé pour que le seed reste rejouable.
    const existing = await prisma.term.findFirst({
      where: { schoolId: school.id, label: term.label },
      select: { id: true },
    });

    const data = {
      label: term.label,
      startDate: new Date(term.startDate),
      endDate: new Date(term.endDate),
    };

    if (existing) await prisma.term.update({ where: { id: existing.id }, data });
    else await prisma.term.create({ data: { schoolId: school.id, ...data } });
  }

  /**
   * Minimum vital pour que les comptes enseignant et parent aient quelque
   * chose à afficher : une classe, une matière, un élève, l'affectation du
   * professeur et le rattachement de la famille.
   *
   * Sans cela, l'enseignant voit « aucune classe affectée » et le parent
   * « aucun enfant associé » — techniquement corrects, mais on ne peut rien
   * essayer. Le jeu de données complet reste `npm run prisma:seed:demo`.
   */
  const klass = await upsertBy(
    () => prisma.class.findFirst({ where: { schoolId: school.id, name: '6e A' } }),
    (id) => prisma.class.findUniqueOrThrow({ where: { id } }),
    () => prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } }),
  );

  const subject = await upsertBy(
    () => prisma.subject.findFirst({ where: { schoolId: school.id, name: 'Mathématiques' } }),
    (id) => prisma.subject.findUniqueOrThrow({ where: { id } }),
    () =>
      prisma.subject.create({
        data: { schoolId: school.id, name: 'Mathématiques', coefficient: 5 },
      }),
  );

  await prisma.teacherAssignment.upsert({
    where: {
      teacherUserId_classId_subjectId: {
        teacherUserId: teacher.id,
        classId: klass.id,
        subjectId: subject.id,
      },
    },
    update: {},
    create: {
      schoolId: school.id,
      teacherUserId: teacher.id,
      classId: klass.id,
      subjectId: subject.id,
    },
  });

  const student = await upsertBy(
    () =>
      prisma.student.findFirst({
        where: { schoolId: school.id, firstName: 'Élève', lastName: 'Démo' },
      }),
    (id) => prisma.student.findUniqueOrThrow({ where: { id } }),
    () =>
      prisma.student.create({
        data: {
          schoolId: school.id,
          classId: klass.id,
          firstName: 'Élève',
          lastName: 'Démo',
        },
      }),
  );

  await prisma.studentParent.upsert({
    where: { studentId_parentUserId: { studentId: student.id, parentUserId: parent.id } },
    update: {},
    create: { studentId: student.id, parentUserId: parent.id },
  });

  console.log('');
  console.log(`École        : ${school.name} (#${school.id})`);
  console.log(`Admin        : ${admin.email} / ${adminPassword}`);
  console.log(`Enseignant   : ${teacher.email} / ${adminPassword}`);
  console.log(`Parent       : ${parent.email} / ${adminPassword}`);
  console.log(`Types de note : ${gradeTypes.map((t) => `${t.code}=${t.weight}`).join(', ')}`);
  console.log(`Année        : ${startYear}-${startYear + 1} · ${terms.length} trimestres`);
  console.log(`Rattachements : ${klass.name} · ${subject.name} · ${student.firstName} ${student.lastName}`);
  console.log('');
  console.log('Jeu de données complet : npm run prisma:seed:demo');
}

/** `upsert` par critère non unique : Prisma l'exige sur un index. */
async function upsertBy<T>(
  find: () => Promise<{ id: number } | null>,
  load: (id: number) => Promise<T>,
  create: () => Promise<T>,
): Promise<T> {
  const existing = await find();
  return existing ? load(existing.id) : create();
}

async function upsertUser(
  schoolId: number,
  data: {
    email: string;
    role: 'admin' | 'teacher' | 'parent';
    firstName: string;
    lastName: string;
    passwordHash: string;
  },
) {
  const email = normalizeEmail(data.email);
  return prisma.user.upsert({
    where: { schoolId_email: { schoolId, email } },
    update: {},
    create: {
      schoolId,
      email,
      role: data.role,
      passwordHash: data.passwordHash,
      firstName: data.firstName,
      lastName: data.lastName,
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
