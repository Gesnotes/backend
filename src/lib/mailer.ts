import { Resend } from 'resend';

import { env } from './env';
import { logger } from './logger';

export interface MailerService {
  send(to: string, subject: string, html: string): Promise<void>;
}

/**
 * Mailer de développement : affiche l'email dans les logs, n'envoie rien et
 * n'entame aucun quota. C'est le défaut (MAILER=console).
 */
class ConsoleMailer implements MailerService {
  async send(to: string, subject: string, html: string): Promise<void> {
    logger.info({ to, subject, html }, '[ConsoleMailer] email non envoyé (mode console)');
  }
}

class ResendMailer implements MailerService {
  private readonly client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    const { error } = await this.client.emails.send({
      from: env.MAIL_FROM,
      to,
      subject,
      html,
    });

    // Un échec d'envoi ne doit pas faire échouer l'appel métier (le compte a
    // bien été créé, le token de reset existe) : on trace et on continue.
    if (error) {
      logger.error({ err: error, to, subject }, "Échec de l'envoi d'email");
    }
  }
}

function createMailer(): MailerService {
  if (env.MAILER === 'resend') {
    if (!env.RESEND_API_KEY) {
      throw new Error('MAILER=resend nécessite RESEND_API_KEY');
    }
    return new ResendMailer(env.RESEND_API_KEY);
  }
  return new ConsoleMailer();
}

export const mailer: MailerService = createMailer();
