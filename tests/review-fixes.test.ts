import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { TEST_PASSWORD, createSchool, createUser, resetDatabase } from './helpers';
import { createApp } from '../src/app';
import { errorHandler } from '../src/middlewares/errorHandler';
import { validate } from '../src/middlewares/validate';

const app = createApp();

let school: { id: number };

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool('ecole-a');
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const login = (identifier: string, password = TEST_PASSWORD) =>
  request(app)
    .post('/auth/login')
    .set('X-School-Subdomain', 'ecole-a')
    .send({ identifier, password });

describe('normalisation des identifiants', () => {
  it('permet de se connecter à un compte créé avec des majuscules', async () => {
    await createUser({ schoolId: school.id, email: 'Parent@Ecole.TEST', role: 'parent' });

    expect((await login('parent@ecole.test')).status).toBe(200);
    expect((await login('Parent@Ecole.TEST')).status).toBe(200);
    expect((await login('  parent@ecole.test  ')).status).toBe(200);
  });

  it('accepte un téléphone saisi avec des espaces ou des tirets', async () => {
    await createUser({
      schoolId: school.id,
      email: 'p@a.test',
      phone: '97 00 00 00',
      role: 'parent',
    });

    expect((await login('97000000')).status).toBe(200);
    expect((await login('97-00-00-00')).status).toBe(200);
  });
});

describe('unicité par école (multi-tenant)', () => {
  it('autorise le même email dans deux écoles différentes', async () => {
    const other = await createSchool('ecole-b');

    await createUser({ schoolId: school.id, email: 'parent@commun.test', role: 'parent' });
    await expect(
      createUser({ schoolId: other.id, email: 'parent@commun.test', role: 'parent' }),
    ).resolves.toBeTruthy();
  });

  it('refuse le même email deux fois dans la même école', async () => {
    await createUser({ schoolId: school.id, email: 'parent@a.test', role: 'parent' });
    await expect(
      createUser({ schoolId: school.id, email: 'parent@a.test', role: 'parent' }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('rotation des refresh tokens', () => {
  beforeEach(async () => {
    await createUser({ schoolId: school.id, email: 'p@a.test', role: 'parent' });
  });

  const refresh = (refreshToken: string) =>
    request(app)
      .post('/auth/refresh')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ refreshToken });

  it('ne délivre qu\'une seule chaîne quand deux rafraîchissements courent en parallèle', async () => {
    const { body } = await login('p@a.test');

    const results = await Promise.all([refresh(body.refreshToken), refresh(body.refreshToken)]);
    const succeeded = results.filter((r) => r.status === 200);

    expect(succeeded).toHaveLength(1);
  });

  it('révoque toute la famille quand un token déjà utilisé est rejoué', async () => {
    const { body } = await login('p@a.test');

    const rotated = await refresh(body.refreshToken);
    expect(rotated.status).toBe(200);

    // Rejeu de l'ancien token : suspicion de vol.
    expect((await refresh(body.refreshToken)).status).toBe(401);

    // Le token légitime issu de la rotation doit lui aussi être coupé.
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });
});

describe('robustesse du socle', () => {
  it('empile deux validate sur la même requête sans planter', async () => {
    const { z } = await import('zod');
    const express = (await import('express')).default;
    const schema = z.object({ a: z.string().optional() });

    // Reproduit le montage routeur + route attendu au lot 9.
    const probe = express();
    probe.get(
      '/double-validate',
      validate({ query: schema }),
      validate({ query: schema }),
      (req, res) => res.json({ query: req.query }),
    );
    probe.use(errorHandler);

    const res = await request(probe).get('/double-validate?a=ok');

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ a: 'ok' });
  });

  it('/health ne divulgue aucun détail interne', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/localhost:5432|postgres|password/i);
  });
});
