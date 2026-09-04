/**
 * Le suivi des erreurs s'initialise avant toute autre importation applicative :
 * le SDK instrumente les modules au chargement, et démarré trop tard il
 * manquerait une partie des erreurs.
 */
import { flushMonitoring, initMonitoring } from './lib/monitoring';

initMonitoring();

import { schedule } from 'node-cron';

import { createApp } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import prisma from './lib/prisma';
import { sendEvaluationReminders } from './services/evaluationReminder.service';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Serveur démarré sur http://localhost:${env.PORT}`);
});

/**
 * Rappel push aux parents, 3 jours avant une évaluation programmée — une
 * fois par jour suffit (`reminderSentAt` évite tout doublon si le serveur
 * redémarre). Câblé ici, jamais dans `app.ts`/`createApp()` : les tests
 * (supertest) n'appellent que `createApp`, jamais ce fichier, donc aucun
 * risque de déclenchement pendant `npm test`.
 */
schedule('0 7 * * *', () => {
  void sendEvaluationReminders().then(({ sent, failed }) => {
    logger.info(`Rappels d'évaluations : ${sent} envoyés, ${failed} échoués`);
  });
});

async function shutdown(signal: string) {
  logger.info(`${signal} reçu, arrêt en cours`);
  server.close();
  // Vider la file avant de sortir : sinon la dernière erreur, souvent celle
  // qui explique l'arrêt, n'atteint jamais la supervision.
  await flushMonitoring();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
