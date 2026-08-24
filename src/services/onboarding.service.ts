import prisma from '../lib/prisma';
import { webAppUrl } from '../lib/env';
import { logger } from '../lib/logger';
import { mailer } from '../lib/mailer';
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

/**
 * Destinataire des notifications internes de nouvelle demande — l'équipe
 * Gesnotes n'a pour l'instant qu'une personne qui traite les inscriptions au
 * téléphone ; un vrai carnet d'adresses d'équipe n'a pas encore de raison
 * d'être avant qu'il y ait plusieurs personnes à prévenir.
 */
const SIGNUP_NOTIFICATION_EMAIL = 'vianneyhoueho@gmail.com';

/**
 * Enregistre la demande ; l'équipe Gesnotes la traite au téléphone, hors
 * application. La notification par email est best-effort (voir `mailer.ts`) :
 * un échec d'envoi ne doit pas faire échouer l'inscription, la demande reste
 * de toute façon consultable sur `/equipe/demandes`.
 */
export async function createSignupRequest(data: SignupRequestInput) {
  const request = await prisma.signupRequest.create({
    data: {
      schoolName: data.schoolName.trim(),
      contactName: data.contactName.trim(),
      email: normalizeEmail(data.email),
      phone: normalizePhone(data.phone),
      city: data.city.trim(),
      levels: data.levels,
    },
  });

  try {
    await mailer.send(
      SIGNUP_NOTIFICATION_EMAIL,
      `Nouvelle demande d'inscription — ${request.schoolName}`,
      `<p>Nouvelle demande d'inscription reçue sur Gesnotes.</p>
       <ul>
         <li><strong>École :</strong> ${request.schoolName}</li>
         <li><strong>Ville :</strong> ${request.city}</li>
         <li><strong>Contact :</strong> ${request.contactName}</li>
         <li><strong>Email :</strong> ${request.email}</li>
         <li><strong>Téléphone :</strong> ${request.phone}</li>
         <li><strong>Niveaux :</strong> ${request.levels.join(', ')}</li>
       </ul>
       <p><a href="${webAppUrl}/equipe/demandes">Voir la demande</a></p>`,
    );
  } catch (cause) {
    // La demande est déjà enregistrée et reste consultable sur
    // /equipe/demandes : un souci d'envoi (réseau, provider en panne) ne doit
    // pas faire échouer l'inscription elle-même.
    logger.error({ err: cause, signupRequestId: request.id }, "Échec de la notification d'inscription");
  }

  return request;
}
