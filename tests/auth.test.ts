import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { TEST_PASSWORD, createSchool, createUser, resetDatabase } from './helpers';
import { createApp } from '../src/app';

const app = createApp();

let school: { id: number; subdomain: string };

const api = () => request(app).post('/auth/login').set('X-School-Subdomain', 'ecole-a');

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool('ecole-a');
  await createUser({
    schoolId: school.id,
    email: 'parent@a.test',
    phone: '97000000',
    role: 'parent',
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('POST /auth/login', () => {
  it('connecte par email', async () => {
    const res = await api().send({ identifier: 'parent@a.test', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('parent@a.test');
  });

  it('connecte par téléphone', async () => {
    const res = await api().send({ identifier: '97000000', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('ne renvoie jamais le hash du mot de passe', async () => {
    const res = await api().send({ identifier: 'parent@a.test', password: TEST_PASSWORD });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('$argon2');
  });

  it('refuse un mauvais mot de passe', async () => {
    const res = await api().send({ identifier: 'parent@a.test', password: 'mauvais' });
    expect(res.status).toBe(401);
  });

  it('refuse un compte archivé, avec le même message qu\'un compte inconnu', async () => {
    await createUser({
      schoolId: school.id,
      email: 'archive@a.test',
      role: 'parent',
      archived: true,
    });

    const archived = await api().send({ identifier: 'archive@a.test', password: TEST_PASSWORD });
    const unknown = await api().send({ identifier: 'inconnu@a.test', password: TEST_PASSWORD });

    expect(archived.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Pas d'énumération : les deux réponses sont indiscernables.
    expect(archived.body).toEqual(unknown.body);
  });

  it("refuse un compte d'une autre école sur ce sous-domaine", async () => {
    const other = await createSchool('ecole-b');
    await createUser({ schoolId: other.id, email: 'admin@b.test', role: 'admin' });

    const res = await api().send({ identifier: 'admin@b.test', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('valide les entrées', async () => {
    const res = await api().send({ identifier: '', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.details).toBeInstanceOf(Array);
  });
});

describe('POST /auth/identify — connexion sans sous-domaine connu', () => {
  const identify = (identifier: string, password: string) =>
    request(app).post('/auth/identify').send({ identifier, password });

  it('connecte directement quand un seul compte correspond', async () => {
    const res = await identify('parent@a.test', TEST_PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('parent@a.test');
    expect(res.body.school.subdomain).toBe('ecole-a');
  });

  it('connecte par téléphone', async () => {
    const res = await identify('97000000', TEST_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('renvoie la liste des écoles quand le même identifiant et mot de passe valent dans deux écoles', async () => {
    const other = await createSchool('ecole-b', 'École B');
    await createUser({ schoolId: other.id, email: 'parent@a.test', role: 'parent' });

    const res = await identify('parent@a.test', TEST_PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ambiguous');
    expect(res.body.schools).toHaveLength(2);
    const subdomains = res.body.schools.map((s: { subdomain: string }) => s.subdomain).sort();
    expect(subdomains).toEqual(['ecole-a', 'ecole-b']);
  });

  it("ne liste que les écoles où le mot de passe saisi est le bon", async () => {
    const other = await createSchool('ecole-b');
    await createUser({ schoolId: other.id, email: 'parent@a.test', role: 'parent', password: 'autremotdepasse' });

    const res = await identify('parent@a.test', TEST_PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.school.subdomain).toBe('ecole-a');
  });

  it('refuse un mauvais mot de passe', async () => {
    const res = await identify('parent@a.test', 'mauvais');
    expect(res.status).toBe(401);
  });

  it('refuse un identifiant inconnu, avec le même statut qu’un mauvais mot de passe', async () => {
    const res = await identify('personne@inconnu.test', TEST_PASSWORD);
    expect(res.status).toBe(401);
  });

  it('refuse un compte archivé', async () => {
    await createUser({ schoolId: school.id, email: 'archive@a.test', role: 'parent', archived: true });
    const res = await identify('archive@a.test', TEST_PASSWORD);
    expect(res.status).toBe(401);
  });

  it('exclut les écoles suspendues', async () => {
    await prisma.school.update({ where: { id: school.id }, data: { archivedAt: new Date() } });
    const res = await identify('parent@a.test', TEST_PASSWORD);
    expect(res.status).toBe(401);
  });

  it('valide les entrées', async () => {
    const res = await identify('', '');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('cycle refresh / logout', () => {
  const login = () => api().send({ identifier: 'parent@a.test', password: TEST_PASSWORD });

  it('fait tourner le refresh token et révoque l\'ancien', async () => {
    const { body } = await login();

    const refreshed = await request(app)
      .post('/auth/refresh')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ refreshToken: body.refreshToken });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(body.refreshToken);

    // L'ancien token ne doit plus fonctionner (rotation).
    const reused = await request(app)
      .post('/auth/refresh')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ refreshToken: body.refreshToken });
    expect(reused.status).toBe(401);
  });

  it('invalide le refresh token côté serveur au logout', async () => {
    const { body } = await login();

    const out = await request(app)
      .post('/auth/logout')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ refreshToken: body.refreshToken });
    expect(out.status).toBe(204);

    const after = await request(app)
      .post('/auth/refresh')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ refreshToken: body.refreshToken });
    expect(after.status).toBe(401);
  });
});

describe('réinitialisation de mot de passe', () => {
  const forgot = (email: string) =>
    request(app)
      .post('/auth/forgot-password')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ email });

  it('répond identiquement que le compte existe ou non', async () => {
    const known = await forgot('parent@a.test');
    const unknown = await forgot('personne@a.test');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    // Mais un token n'est créé que pour le compte réel.
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it('change le mot de passe et invalide les sessions en cours', async () => {
    const session = await api().send({ identifier: 'parent@a.test', password: TEST_PASSWORD });
    await forgot('parent@a.test');

    // Le token en clair n'existe qu'à l'envoi : on le rejoue ici via un
    // token connu, en réécrivant son empreinte comme le ferait le lien email.
    const raw = 'token-de-test-en-clair';
    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    await prisma.passwordResetToken.updateMany({ data: { tokenHash } });

    const reset = await request(app)
      .post('/auth/reset-password')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ token: raw, password: 'nouveaumotdepasse' });
    expect(reset.status).toBe(200);

    // L'ancien mot de passe ne marche plus, le nouveau oui.
    expect((await api().send({ identifier: 'parent@a.test', password: TEST_PASSWORD })).status).toBe(401);
    expect(
      (await api().send({ identifier: 'parent@a.test', password: 'nouveaumotdepasse' })).status,
    ).toBe(200);

    // Les refresh tokens émis avant la réinitialisation sont révoqués.
    const reused = await request(app)
      .post('/auth/refresh')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ refreshToken: session.body.refreshToken });
    expect(reused.status).toBe(401);
  });

  it('refuse un token de réinitialisation déjà utilisé', async () => {
    await forgot('parent@a.test');
    const raw = 'token-usage-unique';
    const crypto = await import('node:crypto');
    await prisma.passwordResetToken.updateMany({
      data: { tokenHash: crypto.createHash('sha256').update(raw).digest('hex') },
    });

    const first = await request(app)
      .post('/auth/reset-password')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ token: raw, password: 'premiermotdepasse' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/auth/reset-password')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ token: raw, password: 'deuxiememotdepasse' });
    expect(second.status).toBe(401);
  });

  it('refuse un mot de passe trop court', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ token: 'peu-importe', password: 'court' });
    expect(res.status).toBe(400);
  });
});
