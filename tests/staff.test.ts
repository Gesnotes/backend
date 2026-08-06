import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { TEST_PASSWORD, createSchool, createStaffUser, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let staffToken: string;

beforeEach(async () => {
  await resetDatabase();
  const staff = await createStaffUser({ email: 'equipe@gesnotes.app' });
  staffToken = (
    await request(app).post('/staff/login').send({ email: 'equipe@gesnotes.app', password: TEST_PASSWORD })
  ).body.accessToken;
  void staff;
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const staffApi = (token = staffToken) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string, body?: object) =>
    request(app).post(p).set('Authorization', `Bearer ${token}`).send(body ?? {}),
});

describe('POST /staff/login', () => {
  it('connecte avec les bons identifiants', async () => {
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.app', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.staff.email).toBe('equipe@gesnotes.app');
  });

  it('refuse un mot de passe incorrect', async () => {
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.app', password: 'mauvais-mot-de-passe' });
    expect(res.status).toBe(401);
  });

  it('refuse un email inconnu', async () => {
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'inconnu@gesnotes.app', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuse un compte archivé', async () => {
    await createStaffUser({ email: 'parti@gesnotes.app', archived: true });
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'parti@gesnotes.app', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('session staff (refresh, logout)', () => {
  it('rafraîchit la session', async () => {
    const login = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.app', password: TEST_PASSWORD });

    const res = await request(app).post('/staff/refresh').send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('déconnecte : le refresh token révoqué ne fonctionne plus', async () => {
    const login = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.app', password: TEST_PASSWORD });

    await request(app).post('/staff/logout').send({ refreshToken: login.body.refreshToken });
    const res = await request(app).post('/staff/refresh').send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(401);
  });
});

describe('GET /staff/me — isolation des deux mondes d’authentification', () => {
  it('refuse une requête sans token', async () => {
    expect((await request(app).get('/staff/me')).status).toBe(401);
  });

  it("refuse le token d'un compte client (école), même valide", async () => {
    const school = await createSchool('ecole-a');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const clientToken = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });

    const res = await request(app).get('/staff/me').set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(401);
  });

  it('ne nécessite aucun X-School-Subdomain', async () => {
    const res = await request(app).get('/staff/me').set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
  });
});

describe('supervision de la plateforme', () => {
  it('GET /staff/overview renvoie les totaux, tous établissements confondus', async () => {
    const a = await createSchool('ecole-a');
    const b = await createSchool('ecole-b');
    await createUser({ schoolId: a.id, email: 'admin@a.test', role: 'admin' });
    await createUser({ schoolId: a.id, email: 'prof@a.test', role: 'teacher' });
    await createUser({ schoolId: b.id, email: 'parent@b.test', role: 'parent' });
    const klassA = await prisma.class.create({ data: { schoolId: a.id, name: '6e A', level: '6e' } });
    await prisma.student.create({
      data: { schoolId: a.id, classId: klassA.id, firstName: 'Ana', lastName: 'Alpha' },
    });
    await prisma.signupRequest.create({
      data: {
        schoolName: 'École C', contactName: 'X Y', email: 'x@c.test', phone: '90000000', city: 'Cotonou',
        levels: ['primaire'],
      },
    });

    const res = await staffApi().get('/staff/overview');

    expect(res.status).toBe(200);
    expect(res.body.schools).toBe(2);
    expect(res.body.students).toBe(1);
    expect(res.body.classes).toBe(1);
    expect(res.body.pendingSignupRequests).toBe(1);
    expect(res.body.users).toMatchObject({ admin: 1, teacher: 1, parent: 1, total: 3 });
  });

  it("GET /staff/schools renvoie les effectifs par école, élèves et comptes archivés exclus", async () => {
    const school = await createSchool('ecole-a', 'École Alpha');
    await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const archivedTeacher = await createUser({ schoolId: school.id, email: 'ancien@a.test', role: 'teacher' });
    await prisma.user.update({ where: { id: archivedTeacher.id }, data: { archivedAt: new Date() } });
    const klass = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
    await prisma.student.create({
      data: { schoolId: school.id, classId: klass.id, firstName: 'Ana', lastName: 'Alpha' },
    });

    const res = await staffApi().get('/staff/schools');

    expect(res.status).toBe(200);
    const row = res.body.find((s: { subdomain: string }) => s.subdomain === 'ecole-a');
    expect(row).toMatchObject({ name: 'École Alpha', students: 1, classes: 1, admins: 1, teachers: 0 });
  });

  it('refuse un token client sur les routes de supervision', async () => {
    const school = await createSchool('ecole-a');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const clientToken = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });

    expect((await staffApi(clientToken).get('/staff/overview')).status).toBe(401);
    expect((await staffApi(clientToken).get('/staff/schools')).status).toBe(401);
  });
});

describe('demandes d’inscription', () => {
  async function seedRequest(overrides: Partial<{ schoolName: string; email: string }> = {}) {
    return prisma.signupRequest.create({
      data: {
        schoolName: overrides.schoolName ?? 'École La Colombe',
        contactName: 'Rosine Adjovi',
        email: overrides.email ?? 'rosine@lacolombe.test',
        phone: '97000000',
        city: 'Cotonou',
        levels: ['garderie', 'maternelle'],
      },
    });
  }

  it('GET /staff/signup-requests liste et filtre par statut', async () => {
    await seedRequest();
    const traitee = await seedRequest({ schoolName: 'École Traitée' });
    await prisma.signupRequest.update({ where: { id: traitee.id }, data: { status: 'traite' } });

    const all = await staffApi().get('/staff/signup-requests');
    expect(all.body).toHaveLength(2);

    const nouveau = await staffApi().get('/staff/signup-requests?status=nouveau');
    expect(nouveau.body).toHaveLength(1);
    expect(nouveau.body[0].schoolName).toBe('École La Colombe');
  });

  it('POST .../accept crée l’école et son premier admin, puis l’invite', async () => {
    const demand = await seedRequest();

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`);

    expect(res.status).toBe(201);
    expect(res.body.school.name).toBe('École La Colombe');
    expect(res.body.school.subdomain).toBe('ecole-la-colombe');

    const admin = await prisma.user.findFirstOrThrow({ where: { schoolId: res.body.school.id } });
    expect(admin.role).toBe('admin');
    expect(admin.email).toBe('rosine@lacolombe.test');
    expect(admin.firstName).toBe('Rosine');
    expect(admin.lastName).toBe('Adjovi');

    // Aucun mot de passe transmis : seule une invitation permet de s'en donner un.
    expect(await prisma.passwordResetToken.count({ where: { userId: admin.id } })).toBe(1);

    const updated = await prisma.signupRequest.findUniqueOrThrow({ where: { id: demand.id } });
    expect(updated.status).toBe('traite');
    expect(updated.schoolId).toBe(res.body.school.id);
  });

  it('accepte avec un sous-domaine et un nom choisis par le staff', async () => {
    const demand = await seedRequest();

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`, {
      subdomain: 'la-colombe-cotonou',
      schoolName: 'École La Colombe (Cotonou)',
    });

    expect(res.body.school.subdomain).toBe('la-colombe-cotonou');
    expect(res.body.school.name).toBe('École La Colombe (Cotonou)');
  });

  it('ajoute un suffixe si le sous-domaine par défaut est déjà pris', async () => {
    await createSchool('ecole-la-colombe');
    const demand = await seedRequest();

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`);

    expect(res.status).toBe(201);
    expect(res.body.school.subdomain).toBe('ecole-la-colombe-2');
  });

  it('refuse d’accepter deux fois la même demande', async () => {
    const demand = await seedRequest();
    await staffApi().post(`/staff/signup-requests/${demand.id}/accept`);

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`);
    expect(res.status).toBe(409);
  });

  it('refuse une demande inconnue', async () => {
    const res = await staffApi().post('/staff/signup-requests/999999/accept');
    expect(res.status).toBe(404);
  });

  it('POST .../decline marque la demande traitée sans créer d’école', async () => {
    const demand = await seedRequest();

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/decline`);

    expect(res.status).toBe(204);
    const updated = await prisma.signupRequest.findUniqueOrThrow({ where: { id: demand.id } });
    expect(updated.status).toBe('traite');
    expect(updated.schoolId).toBeNull();
    expect(await prisma.school.count()).toBe(0);
  });

  it('refuse de refuser deux fois la même demande', async () => {
    const demand = await seedRequest();
    await staffApi().post(`/staff/signup-requests/${demand.id}/decline`);

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/decline`);
    expect(res.status).toBe(409);
  });
});
