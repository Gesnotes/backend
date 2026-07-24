/**
 * Le suivi des erreurs s'initialise avant toute autre importation applicative :
 * le SDK instrumente les modules au chargement, et démarré trop tard il
 * manquerait une partie des erreurs.
 */
import { flushMonitoring, initMonitoring } from './lib/monitoring';

initMonitoring();

import { createApp } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import prisma from './lib/prisma';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Serveur démarré sur http://localhost:${env.PORT}`);
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
