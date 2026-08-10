import prisma from '../lib/prisma';
import { normalizeEmail, normalizePhone } from '../lib/normalize';

/**
 * Avant qu'une école existe : demander à le devenir, sans compte ni mot de
 * passe à créer sur le coup — l'inscription hybride se termine au téléphone
 * avec l'équipe Gesnotes. Public (`publicRoute`, monté avant `schoolContext`).
 */

export interface SignupRequestInput {
  schoolName: string;
  contactName: string;
  email: string;
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
      email: normalizeEmail(data.email),
      phone: normalizePhone(data.phone),
      city: data.city.trim(),
      levels: data.levels,
    },
  });
}
