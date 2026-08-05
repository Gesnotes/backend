import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number; subdomain: string };
let schoolB: { id: number; subdomain: string };
let adminToken: string;
let parentToken: string;
let tokenFromSchoolB: string;

beforeAll(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });
  const adminB = await createUser({ schoolId: schoolB.id, email: 'admin@b.test', role: 'admin' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });
  tokenFromSchoolB = signAccessToken({ userId: adminB.id, schoolId: schoolB.id, role: 'admin' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** En local, l'école se choisit par en-tête (req.hostname vaut "localhost"). */
const as = (subdomain: string, token?: string) => {
  const req = request(app);
  return {
    get: (path: string) => {
      const r = req.get(path).set('X-School-Subdomain', subdomain);
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    },
  };
};

describe('gardes des routes (plan lot 2)', () => {
  it('401 sans token sur une route métier', async () => {
    const res = await as('ecole-a').get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 avec un token illisible', async () => {
    const res = await as('ecole-a', 'pas-un-jwt').get('/me');
    expect(res.status).toBe(401);
  });

  it('403 avec le mauvais rôle', async () => {
    // Route d'administration reelle : /teachers est reserve au role admin.
    const res = await as('ecole-a', parentToken).get('/teachers');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it("403 quand le sous-domaine n'est pas celui du token (isolation multi-écoles)", async () => {
    const res = await as('ecole-a', tokenFromSchoolB).get('/me');
    expect(res.status).toBe(403);
    // Le message dit à l'utilisateur ce qui se passe, sans vocabulaire
    // technique : « sous-domaine incohérent » ne veut rien dire pour lui.
    expect(res.body.error.message).toMatch(/établissement/i);
  });

  it('200 avec le bon rôle sur le bon sous-domaine', async () => {
    const res = await as('ecole-a', adminToken).get('/teachers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('404 sur un sous-domaine inconnu', async () => {
    const res = await as('ecole-inexistante').get('/me');
    expect(res.status).toBe(404);
  });

  it('404 au format standard sur une route inconnue', async () => {
    const res = await as('ecole-a', adminToken).get('/route-qui-nexiste-pas');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('/health répond sans école ni token', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('connected');
  });
});
