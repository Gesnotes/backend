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
  const school = await prisma.school.upsert({
    where: { subdomain: 'ecole-demo' },
    update: {},
    create: { name: 'École de démonstration', subdomain: 'ecole-demo' },
  });

  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234';
  const adminEmail = normalizeEmail('admin@ecole-demo.test');
  const admin = await prisma.user.upsert({
    where: { schoolId_email: { schoolId: school.id, email: adminEmail } },
    update: {},
    create: {
      schoolId: school.id,
      email: adminEmail,
      passwordHash: await argon2.hash(adminPassword),
      role: 'admin',
      firstName: 'Admin',
      lastName: 'Démo',
    },
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

  console.log(`École   : ${school.name} (${school.subdomain})`);
  console.log(`Admin   : ${admin.email} / ${adminPassword}`);
  console.log(`Types de note : ${gradeTypes.map((t) => `${t.code}=${t.weight}`).join(', ')}`);
  console.log(`Année   : ${startYear}-${startYear + 1} · ${terms.length} trimestres`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
