import 'dotenv/config';

import argon2 from 'argon2';

import prisma from '../src/lib/prisma';
import { normalizeEmail } from '../src/lib/normalize';

/**
 * Premier compte de l'équipe Gesnotes.
 *
 * Pas de self-service pour ce rôle (n'importe qui pourrait sinon s'inscrire
 * comme staff) : c'est ce script, lancé une fois par un membre de l'équipe
 * ayant accès à la base, qui crée le tout premier compte. Idempotent :
 * relancer ne duplique rien, met seulement le mot de passe à jour.
 *
 *   npm run prisma:seed:staff
 */

const EMAIL = normalizeEmail(process.env.SEED_STAFF_EMAIL ?? 'equipe@gesnotes.bj');
const PASSWORD = process.env.SEED_STAFF_PASSWORD ?? 'demo1234';

async function main() {
  const passwordHash = await argon2.hash(PASSWORD);

  const staff = await prisma.staffUser.upsert({
    where: { email: EMAIL },
    update: { passwordHash, archivedAt: null },
    create: { email: EMAIL, passwordHash, firstName: 'Équipe', lastName: 'Gesnotes' },
  });

  console.log(`Compte staff prêt : ${staff.email} / ${PASSWORD}`);
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
