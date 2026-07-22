import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL est absente de l\'environnement (voir .env.example)');
}

const adapter = new PrismaPg({ connectionString });

/**
 * Singleton du client Prisma.
 *
 * Un seul PrismaClient pour toute l'application : chaque instanciation ouvre
 * son propre pool de connexions, ce qui sature rapidement PostgreSQL.
 * Tous les services doivent importer celui-ci.
 */
const prisma = new PrismaClient({ adapter });

export default prisma;
