import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import { env, webAppUrl } from '../lib/env';
import { hashToken } from '../lib/tokens';
import { mailer } from '../lib/mailer';

type InvitedRole = 'admin' | 'teacher' | 'parent';

const WORDING: Record<InvitedRole, { subject: string; intro: string }> = {
  admin: {
    subject: 'Votre espace Gesnotes est prêt',
    intro: "L'équipe Gesnotes a créé l'espace de votre établissement.",
  },
  teacher: {
    subject: 'Votre compte enseignant Gesnotes',
    intro: 'Un compte enseignant a été créé pour vous sur Gesnotes.',
  },
  parent: {
    subject: 'Suivez les notes de votre enfant sur Gesnotes',
    intro:
      "L'établissement de votre enfant vous a ouvert un accès pour suivre ses notes sur Gesnotes.",
  },
};

/**
 * Invitation d'un compte créé par l'administration.
 *
 * Aucun mot de passe n'est jamais transmis : le compte est créé avec un secret
 * aléatoire inutilisable, et cet email porte le seul moyen d'en définir un.
 * Le token réutilise la table `password_reset_tokens` — c'est le même
 * mécanisme, à usage unique, haché en base et expirant.
 */
export async function sendInvitation(userId: number, email: string, role: InvitedRole) {
  const rawToken = crypto.randomBytes(32).toString('hex');

  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + env.INVITATION_TTL_HOURS * 60 * 60_000),
    },
  });

  const wording = WORDING[role];
  const link = `${webAppUrl}/reset-password?token=${rawToken}`;

  await mailer.send(
    email,
    wording.subject,
    `<p>Bonjour,</p>
     <p>${wording.intro}</p>
     <p><a href="${link}">Définir mon mot de passe</a></p>
     <p>Ce lien expire dans ${env.INVITATION_TTL_HOURS} heures.</p>`,
  );
}
