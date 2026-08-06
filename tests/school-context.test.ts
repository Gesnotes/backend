import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { TEST_PASSWORD, createSchool, createUser, resetDatabase } from './helpers';

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const login = (subdomain: string | undefined, identifier: string, password = TEST_PASSWORD) => {
  const req = request(app).post('/auth/login');
  if (subdomain) req.set('X-School-Subdomain', subdomain);
  return req.send({ identifier, password });
};

/**
 * Confort de développement, désactivé en production.
 *
 * Le sous-domaine doit être juste dans le `.env` du backend **et** dans celui
 * du frontend, deux fichiers qui divergent sans bruit. La conséquence était un
 * « Identifiants invalides » sur des identifiants pourtant corrects : le
 * message le plus trompeur possible.
 */
describe('résolution de l’école en développement', () => {
  it('retombe sur la seule école de la base quand le sous-domaine est inconnu', async () => {
    const school = await createSchool('ecole-a');
    await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });

    const res = await login('sous-domaine-qui-nexiste-pas', 'admin@a.test');

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@a.test');
  });

  it('fonctionne aussi sans aucun sous-domaine transmis', async () => {
    const school = await createSchool('ecole-a');
    await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });

    expect((await login(undefined, 'admin@a.test')).status).toBe(200);
  });

  /**
   * Deux écoles : deviner serait dangereux, on refuse en nommant les choix
   * possibles plutôt que de laisser l'utilisateur chercher.
   */
  it('refuse de deviner dès qu’il existe plusieurs écoles, et liste les sous-domaines', async () => {
    const a = await createSchool('ecole-a');
    await createSchool('ecole-b');
    await createUser({ schoolId: a.id, email: 'admin@a.test', role: 'admin' });

    const res = await login('sous-domaine-qui-nexiste-pas', 'admin@a.test');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('ecole-a');
    expect(res.body.error.message).toContain('ecole-b');
  });

  it('conserve l’isolation : un compte reste inaccessible depuis une autre école', async () => {
    const a = await createSchool('ecole-a');
    await createSchool('ecole-b');
    await createUser({ schoolId: a.id, email: 'admin@a.test', role: 'admin' });

    // Sous-domaine valide mais autre établissement : le repli ne s'applique
    // pas, et le compte n'est pas joignable depuis ecole-b.
    expect((await login('ecole-b', 'admin@a.test')).status).toBe(401);
  });

  it('oriente vers le seed quand la base est vide', async () => {
    const res = await login('ecole-a', 'admin@a.test');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('prisma:seed');
  });
});

/**
 * Connexion sans sous-domaine (plan §1.2 bis) : sur le domaine principal,
 * l'école vient de l'en-tête que le frontend pose une fois choisie par
 * l'utilisateur, pas d'une adresse à taper. Contrairement au repli
 * mono-école ci-dessus, ce mécanisme reste actif quel que soit le nombre
 * d'écoles — c'est le cas réel visé, pas seulement un confort de développement.
 */
describe('résolution de l’école par en-tête (connexion sans sous-domaine)', () => {
  it("identifie la bonne école par l'en-tête même quand plusieurs écoles existent", async () => {
    const a = await createSchool('ecole-a');
    await createSchool('ecole-b');
    await createUser({ schoolId: a.id, email: 'admin@a.test', role: 'admin' });

    const res = await login('ecole-a', 'admin@a.test');
    expect(res.status).toBe(200);
  });

  it("refuse un compte d'une autre école même avec un en-tête valide", async () => {
    const a = await createSchool('ecole-a');
    await createSchool('ecole-b');
    await createUser({ schoolId: a.id, email: 'admin@a.test', role: 'admin' });

    expect((await login('ecole-b', 'admin@a.test')).status).toBe(401);
  });
});
