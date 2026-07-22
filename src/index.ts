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
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
