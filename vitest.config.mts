
import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:admin@localhost:5432/gesnotes_test';

// globalSetup s'exécute dans le processus principal, où `test.env` ne
// s'applique pas encore : la variable doit être posée dès le chargement.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    // Base de test dédiée : les tests effacent les données entre les cas et ne
    // doivent jamais toucher la base de développement.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'secret-de-test-suffisamment-long-pour-passer-la-validation',
      MAILER: 'console',
    },
    // Les fichiers partagent la même base : exécution en série.
    fileParallelism: false,
    /**
     * Le pool `forks` (défaut) fait planter des workers par intermittence sur
     * cette suite — « Worker exited unexpectedly », sans échec de test, une
     * fois sur deux ou trois. Reproduit sur la suite complète comme sur un
     * fichier isolé, jamais avec `threads`.
     */
    pool: 'threads',
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
