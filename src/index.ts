import 'dotenv/config';

import express from 'express';

import prisma from './lib/prisma';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Middleware pour lire le JSON dans les requêtes
app.use(express.json());

// Route de base
app.get('/', (_req, res) => {
  res.send('Bienvenue sur mon serveur Express !');
});

// Vérifie que la connexion à la base fonctionne
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'erreur inconnue',
    });
  }
});

// Exemple : liste des établissements
app.get('/schools', async (_req, res) => {
  const schools = await prisma.school.findMany();
  res.json(schools);
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});

// Ferme proprement la connexion Prisma
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
