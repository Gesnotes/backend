import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { TEST_PASSWORD, createSchool, createUser, resetDatabase } from './helpers';
import { createApp } from '../src/app';
import { revokeAllSessions } from '../src/services/auth.service';

const app = createApp();

let school: { id: number };

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool('ecole-a');
  await createUser({ schoolId: school.id, email: 'p@a.test', role: 'parent' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const login = () =>
  request(app)
    .post('/auth/identify')
    .send({ identifier: 'p@a.test', password: TEST_PASSWORD });

const me = (accessToken: string) =>
  request(app).get('/me').set('Authorization', `Bearer ${accessToken}`);

/**
 * Avec un access token longue durée (30 jours), l'expiration ne protège plus
 * rien : ces tests vérifient que la révocation côté serveur fonctionne, sinon
 * un logout ou un archivage resterait sans effet pendant un mois.
 */
describe('révocation des access tokens longue durée', () => {
  it('coupe le token immédiatement au logout', async () => {
    const { body } = await login();
    expect((await me(body.accessToken)).status).toBe(200);

    await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .send({ refreshToken: body.refreshToken });

    expect((await me(body.accessToken)).status).toBe(401);
  });

  it("coupe le token dès que le compte est archivé", async () => {
    const { body } = await login();
    expect((await me(body.accessToken)).status).toBe(200);

    await prisma.user.updateMany({ where: { email: 'p@a.test' }, data: { archivedAt: new Date() } });

    expect((await me(body.accessToken)).status).toBe(401);
  });

  it('coupe le token après revokeAllSessions', async () => {
    const { body } = await login();
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'p@a.test' } });

    await revokeAllSessions(user.id);

    expect((await me(body.accessToken)).status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('coupe le token après une réinitialisation de mot de passe', async () => {
    const { body } = await login();
    const crypto = await import('node:crypto');

    await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'p@a.test' });

    const raw = 'token-reset-sessions';
    await prisma.passwordResetToken.updateMany({
      data: { tokenHash: crypto.createHash('sha256').update(raw).digest('hex') },
    });
    await request(app)
      .post('/auth/reset-password')
      .send({ token: raw, password: 'nouveaumotdepasse' });

    expect((await me(body.accessToken)).status).toBe(401);
  });

  it('applique un changement de rôle sans attendre l\'expiration du token', async () => {
    const { body } = await login();
    expect((await request(app).get('/teachers').set('Authorization', `Bearer ${body.accessToken}`)).status).toBe(403);

    await prisma.user.updateMany({ where: { email: 'p@a.test' }, data: { role: 'admin' } });

    const promoted = await request(app)
      .get('/teachers')
      .set('Authorization', `Bearer ${body.accessToken}`);
    expect(promoted.status).toBe(200);
  });
});
