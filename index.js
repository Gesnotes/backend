require('dotenv').config();

const express = require('express');
const prisma = require('./src/prisma');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware pour lire le JSON dans les requêtes
app.use(express.json());

// Route de base
app.get('/', (req, res) => {
  res.send('Bienvenue sur mon serveur Express !');
});

// Vérifie que la connexion à la base fonctionne
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Exemple : liste des établissements
app.get('/schools', async (req, res) => {
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
