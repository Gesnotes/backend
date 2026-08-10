import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let schoolB: { id: number };
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
  await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });
  tokenFromSchoolB = signAccessToken({ userId: adminB.id, schoolId: schoolB.id, role: 'admin' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** L'école n'est plus déduite que du token : plus d'en-tête ni de sous-domaine à fixer. */
const as = (token?: string) => {
  const req = request(app);
  return {
    get: (path: string) => {
      const r = req.get(path);
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    },
  };
};

describe('gardes des routes (plan lot 2)', () => {
  it('401 sans token sur une route métier', async () => {
    const res = await as().get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 avec un token illisible', async () => {
    const res = await as('pas-un-jwt').get('/me');
    expect(res.status).toBe(401);
  });

  it('403 avec le mauvais rôle', async () => {
    // Route d'administration reelle : /teachers est reserve au role admin.
    const res = await as(parentToken).get('/teachers');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('200 avec le bon rôle, données limitées à son école (isolation multi-écoles)', async () => {
    const resA = await as(adminToken).get('/teachers');
    expect(resA.status).toBe(200);
    expect(resA.body).toHaveLength(1);

    const resB = await as(tokenFromSchoolB).get('/teachers');
    expect(resB.status).toBe(200);
    expect(resB.body).toHaveLength(0);
  });

  it('404 au format standard sur une route inconnue', async () => {
    const res = await as(adminToken).get('/route-qui-nexiste-pas');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('/health répond sans école ni token', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('connected');
  });
});
