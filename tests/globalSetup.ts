import { execSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Prépare une base de test dédiée.
 *
 * Les tests effacent les données entre les cas : ils ne doivent jamais toucher
 * la base de développement. La base est créée si absente, puis migrée.
 */
export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquante pour les tests');

  const target = new URL(url);
  const databaseName = target.pathname.slice(1);

  if (!databaseName.includes('test')) {
    throw new Error(
      `Refus de lancer les tests sur la base "${databaseName}" : son nom doit contenir "test".`,
    );
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    databaseName,
  ]);
  if (rowCount === 0) {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  }
  await admin.end();

  // Commande unique plutôt que `execFileSync(..., { shell: true })` : Node
  // refuse de lancer un .cmd sans shell sur Windows (EINVAL), et passer des
  // arguments séparés avec shell:true les concatène sans échappement (DEP0190).
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
