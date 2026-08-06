import prisma from '../lib/prisma';
import { normalizePhone } from '../lib/normalize';

/**
 * Avant qu'une école existe.
 *
 * Deux besoins, tous deux public (`publicRoute`, montés avant `schoolContext`
 * — aucune école n'est encore résolue à ce stade) :
 *  - retrouver son école déjà cliente, pour se connecter sans sous-domaine ;
 *  - demander à le devenir, sans compte ni mot de passe à créer sur le coup —
 *    l'inscription hybride se termine au téléphone avec l'équipe Gesnotes.
 */

/** Écoles dont le nom ou la ville correspond à la recherche, au format public. */
export async function searchSchools(q: string) {
  const schools = await prisma.school.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, subdomain: true, city: true },
    orderBy: { name: 'asc' },
    take: 10,
  });

  return schools;
}

export interface SignupRequestInput {
  schoolName: string;
  contactName: string;
  phone: string;
  city: string;
  levels: string[];
}

/** Enregistre la demande ; l'équipe Gesnotes la traite au téléphone, hors application. */
export async function createSignupRequest(data: SignupRequestInput) {
  await prisma.signupRequest.create({
    data: {
      schoolName: data.schoolName.trim(),
      contactName: data.contactName.trim(),
      phone: normalizePhone(data.phone),
      city: data.city.trim(),
      levels: data.levels,
    },
  });
}
