import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { type Messaging, getMessaging } from 'firebase-admin/messaging';

import { env } from './env';
import { logger } from './logger';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * Page ouverte au clic sur la notification, côté Web.
   *
   * Sans elle, le clic ouvre la racine de l'application : le parent reçoit
   * « Nouvelle note en Mathématiques » et atterrit sur l'accueil, à charge
   * pour lui de retrouver la note. C'est la seule information qui rende la
   * notification actionnable.
   */
  link?: string;
}

export interface PushResult {
  /** Tokens rejetés définitivement par FCM : à purger de la base. */
  invalidTokens: string[];
}

/**
 * Envoyeur de notifications, derrière une interface.
 *
 * Les tests et le développement utilisent `console` : rien n'est envoyé, aucun
 * quota n'est consommé, et le message est tracé. Basculer en production ne
 * change qu'une variable d'environnement.
 */
export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}

class ConsolePushSender implements PushSender {
  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    logger.info({ tokens: tokens.length, message }, '[ConsolePush] notification non envoyée');
    return { invalidTokens: [] };
  }
}

class FcmPushSender implements PushSender {
  private readonly messaging: Messaging;

  constructor(credentials: { projectId: string; clientEmail: string; privateKey: string }) {
    const app = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert({
            projectId: credentials.projectId,
            clientEmail: credentials.clientEmail,
            // Les sauts de ligne de la clé passent en \n littéral dans un .env
            privateKey: credentials.privateKey.replace(/\\n/g, '\n'),
          }),
        });

    this.messaging = getMessaging(app);
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    if (tokens.length === 0) return { invalidTokens: [] };

    const response = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
      webpush: {
        notification: {
          icon: '/icons/gesnotes.svg',
          badge: '/icons/gesnotes.svg',
          // Une notification par note : deux notes différentes ne doivent pas
          // se remplacer l'une l'autre dans le centre de notifications.
          tag: message.data?.gradeId ? `grade-${message.data.gradeId}` : undefined,
        },
        ...(message.link ? { fcmOptions: { link: message.link } } : {}),
      },
    });

    const invalidTokens: string[] = [];

    response.responses.forEach((result, index) => {
      if (result.success) return;

      const code = result.error?.code;
      // Appareil désinstallé ou token périmé : il ne redeviendra jamais valide.
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument'
      ) {
        const token = tokens[index];
        if (token) invalidTokens.push(token);
      } else {
        logger.warn({ err: result.error }, "Échec d'envoi push, token conservé");
      }
    });

    return { invalidTokens };
  }
}

function createSender(): PushSender {
  if (env.PUSH !== 'fcm') return new ConsolePushSender();

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      'PUSH=fcm nécessite FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL et FIREBASE_PRIVATE_KEY ' +
        '(compte de service Firebase, pas la configuration web du frontend).',
    );
  }

  return new FcmPushSender({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY,
  });
}

/** Objet mutable pour rester observable depuis les tests. */
export const pushSender: PushSender = createSender();
