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

  console.log(`École   : ${school.name} (${school.subdomain})`);
  console.log(`Admin   : ${admin.email} / ${adminPassword}`);
  console.log(`Types de note : ${gradeTypes.map((t) => `${t.code}=${t.weight}`).join(', ')}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
