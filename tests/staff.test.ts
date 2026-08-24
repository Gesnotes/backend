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
  const staff = await createStaffUser({ email: 'equipe@gesnotes.bj' });
  staffToken = (
    await request(app).post('/staff/login').send({ email: 'equipe@gesnotes.bj', password: TEST_PASSWORD })
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
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

describe('POST /staff/login', () => {
  it('connecte avec les bons identifiants', async () => {
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.staff.email).toBe('equipe@gesnotes.bj');
  });

  it('refuse un mot de passe incorrect', async () => {
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: 'mauvais-mot-de-passe' });
    expect(res.status).toBe(401);
  });

  it('refuse un email inconnu', async () => {
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'inconnu@gesnotes.bj', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuse un compte archivé', async () => {
    await createStaffUser({ email: 'parti@gesnotes.bj', archived: true });
    const res = await request(app)
      .post('/staff/login')
      .send({ email: 'parti@gesnotes.bj', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('session staff (refresh, logout)', () => {
  it('rafraîchit la session', async () => {
    const login = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: TEST_PASSWORD });

    const res = await request(app).post('/staff/refresh').send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('déconnecte : le refresh token révoqué ne fonctionne plus', async () => {
    const login = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: TEST_PASSWORD });

    await request(app).post('/staff/logout').send({ refreshToken: login.body.refreshToken });
    const res = await request(app).post('/staff/refresh').send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(401);
  });

  /**
   * Sans ça, un access token émis avant la déconnexion resterait valable
   * jusqu'à son expiration (30 jours par défaut) — le pendant staff de
   * tests/sessions.test.ts pour les comptes école.
   */
  it("déconnecte : l'access token déjà émis ne fonctionne plus non plus", async () => {
    const login = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: TEST_PASSWORD });

    await request(app).post('/staff/logout').send({ refreshToken: login.body.refreshToken });

    const res = await request(app)
      .get('/staff/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(401);
  });
});

describe('réinitialisation de mot de passe (staff)', () => {
  const forgot = (email: string) => request(app).post('/staff/forgot-password').send({ email });

  it('répond identiquement que le compte existe ou non', async () => {
    const known = await forgot('equipe@gesnotes.bj');
    const unknown = await forgot('personne@gesnotes.bj');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    expect(await prisma.staffPasswordResetToken.count()).toBe(1);
  });

  it('ne crée pas de token pour un compte archivé', async () => {
    await createStaffUser({ email: 'parti@gesnotes.bj', archived: true });

    await forgot('parti@gesnotes.bj');

    expect(await prisma.staffPasswordResetToken.count()).toBe(0);
  });

  it('change le mot de passe et invalide les sessions en cours', async () => {
    const login = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: TEST_PASSWORD });
    await forgot('equipe@gesnotes.bj');

    // Le token en clair n'existe qu'à l'envoi : on le rejoue ici via un
    // token connu, en réécrivant son empreinte comme le ferait le lien email.
    const raw = 'token-de-test-en-clair';
    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    await prisma.staffPasswordResetToken.updateMany({ data: { tokenHash } });

    const reset = await request(app)
      .post('/staff/reset-password')
      .send({ token: raw, password: 'nouveaumotdepasse' });
    expect(reset.status).toBe(200);

    const oldLogin = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/staff/login')
      .send({ email: 'equipe@gesnotes.bj', password: 'nouveaumotdepasse' });
    expect(newLogin.status).toBe(200);

    const reused = await request(app)
      .post('/staff/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(reused.status).toBe(401);
  });

  it('refuse un token de réinitialisation déjà utilisé', async () => {
    await forgot('equipe@gesnotes.bj');
    const raw = 'token-usage-unique';
    const crypto = await import('node:crypto');
    await prisma.staffPasswordResetToken.updateMany({
      data: { tokenHash: crypto.createHash('sha256').update(raw).digest('hex') },
    });

    const first = await request(app)
      .post('/staff/reset-password')
      .send({ token: raw, password: 'premiermotdepasse' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/staff/reset-password')
      .send({ token: raw, password: 'deuxiememotdepasse' });
    expect(second.status).toBe(401);
  });

  it('refuse un mot de passe trop court', async () => {
    const res = await request(app)
      .post('/staff/reset-password')
      .send({ token: 'peu-importe', password: 'court' });
    expect(res.status).toBe(400);
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

  it('accepte un token staff valable', async () => {
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
    const row = res.body.find((s: { id: number }) => s.id === school.id);
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

    // Sans ça, cette école ne pourrait jamais créer la moindre évaluation :
    // aucune route ne permet de créer un type de note après coup.
    const gradeTypes = await prisma.gradeType.findMany({
      where: { schoolId: res.body.school.id },
      orderBy: { position: 'asc' },
    });
    expect(gradeTypes.map((t) => t.code)).toEqual(['interrogation', 'devoir', 'composition']);
  });

  it('provisionne les matières et une classe par niveau selon les niveaux cochés', async () => {
    const demand = await seedRequest();
    // La demande par défaut coche garderie + maternelle (mode présence,
    // aucune matière à noter) : un cycle avec matières la remplace ici.
    await prisma.signupRequest.update({
      where: { id: demand.id },
      data: { levels: ['collège'] },
    });

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`);
    expect(res.status).toBe(201);
    const schoolId = res.body.school.id as number;

    const classes = await prisma.class.findMany({ where: { schoolId }, orderBy: { level: 'asc' } });
    expect(classes.map((c) => c.level)).toEqual(['3e', '4e', '5e', '6e']);
    expect(classes.every((c) => c.mode === 'notes')).toBe(true);

    const subjects = await prisma.subject.findMany({ where: { schoolId } });
    expect(subjects.map((s) => s.name).sort()).toEqual(
      ['Anglais', 'EPS', 'Français', 'Histoire-Géographie', 'Mathématiques', 'Physique-Chimie', 'SVT'].sort(),
    );
    expect(subjects.every((s) => Number(s.coefficient) === 1)).toBe(true);

    // Chaque matière est rattachée à chacune des quatre classes du collège.
    const coefficients = await prisma.subjectCoefficient.findMany({ where: { class: { schoolId } } });
    expect(coefficients).toHaveLength(subjects.length * classes.length);
  });

  it('provisionne un cycle sans matières (mode présence) sans créer aucun coefficient', async () => {
    const demand = await seedRequest(); // garderie + maternelle par défaut

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`);
    const schoolId = res.body.school.id as number;

    const classes = await prisma.class.findMany({ where: { schoolId } });
    expect(classes.map((c) => c.level).sort()).toEqual(
      ['Garderie', 'Grande Section', 'Moyenne Section', 'Petite Section'].sort(),
    );
    expect(classes.every((c) => c.mode === 'presence')).toBe(true);
    expect(await prisma.subject.count({ where: { schoolId } })).toBe(0);
    expect(await prisma.subjectCoefficient.count({ where: { class: { schoolId } } })).toBe(0);
  });

  it('ignore un niveau qui ne correspond à aucun gabarit connu', async () => {
    const demand = await seedRequest();
    await prisma.signupRequest.update({
      where: { id: demand.id },
      data: { levels: ['formation professionnelle'] },
    });

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`);
    const schoolId = res.body.school.id as number;

    expect(await prisma.class.count({ where: { schoolId } })).toBe(0);
    expect(await prisma.subject.count({ where: { schoolId } })).toBe(0);
  });

  it('accepte avec un nom choisi par le staff', async () => {
    const demand = await seedRequest();

    const res = await staffApi().post(`/staff/signup-requests/${demand.id}/accept`, {
      schoolName: 'École La Colombe (Cotonou)',
    });

    expect(res.body.school.name).toBe('École La Colombe (Cotonou)');
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

describe('suspendre / restaurer / supprimer une école', () => {
  it('DELETE /staff/schools/:id suspend sans rien détruire', async () => {
    const school = await createSchool('ecole-a', 'École Alpha');
    await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });

    const res = await staffApi().delete(`/staff/schools/${school.id}`);

    expect(res.status).toBe(204);
    const updated = await prisma.school.findUniqueOrThrow({ where: { id: school.id } });
    expect(updated.archivedAt).not.toBeNull();
    expect(await prisma.user.count({ where: { schoolId: school.id } })).toBe(1);
  });

  it('révoque les sessions en cours à la suspension', async () => {
    const school = await createSchool('ecole-a');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const login = await request(app)
      .post('/auth/identify')
      .send({ identifier: 'admin@a.test', password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    await staffApi().delete(`/staff/schools/${school.id}`);

    // La suspension bloque déjà tout au niveau de schoolContext (403, testé
    // séparément) : la révocation se vérifie donc directement en base, plutôt
    // que via /auth/refresh qui n'est de toute façon plus atteignable.
    const token = await prisma.refreshToken.findFirstOrThrow({ where: { userId: admin.id } });
    expect(token.revokedAt).not.toBeNull();
    const updatedAdmin = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(updatedAdmin.sessionsRevokedAt).not.toBeNull();
  });

  it('refuse la connexion sur une école suspendue, sans le distinguer d’un identifiant inconnu', async () => {
    const school = await createSchool('ecole-a');
    await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    await staffApi().delete(`/staff/schools/${school.id}`);

    const res = await request(app)
      .post('/auth/identify')
      .send({ identifier: 'admin@a.test', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('coupe une session déjà ouverte quand son école est suspendue entre-temps (schoolContext)', async () => {
    const school = await createSchool('ecole-a');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const token = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });

    await staffApi().delete(`/staff/schools/${school.id}`);

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/établissement/i);
  });

  it('refuse de suspendre deux fois la même école', async () => {
    const school = await createSchool('ecole-a');
    await staffApi().delete(`/staff/schools/${school.id}`);

    const res = await staffApi().delete(`/staff/schools/${school.id}`);
    expect(res.status).toBe(409);
  });

  it('refuse une école inconnue', async () => {
    const res = await staffApi().delete('/staff/schools/999999');
    expect(res.status).toBe(404);
  });

  it('POST .../restore réactive une école suspendue', async () => {
    const school = await createSchool('ecole-a');
    await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    await staffApi().delete(`/staff/schools/${school.id}`);

    const res = await staffApi().post(`/staff/schools/${school.id}/restore`);
    expect(res.status).toBe(204);

    const updated = await prisma.school.findUniqueOrThrow({ where: { id: school.id } });
    expect(updated.archivedAt).toBeNull();

    const login = await request(app)
      .post('/auth/identify')
      .send({ identifier: 'admin@a.test', password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('refuse de restaurer une école qui ne l’est pas', async () => {
    const school = await createSchool('ecole-a');
    const res = await staffApi().post(`/staff/schools/${school.id}/restore`);
    expect(res.status).toBe(409);
  });

  it('DELETE ?permanent=true supprime l’école et tout ce qu’elle contient', async () => {
    const school = await createSchool('ecole-a', 'École Alpha');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const klass = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
    const student = await prisma.student.create({
      data: { schoolId: school.id, classId: klass.id, firstName: 'Ana', lastName: 'Alpha' },
    });
    const subject = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } });
    const gradeType = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2 },
    });
    const term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });
    await prisma.evaluation.create({
      data: {
        schoolId: school.id, classId: klass.id, subjectId: subject.id, gradeTypeId: gradeType.id,
        termId: term.id, label: 'Éval', maxValue: 20,
      },
    });
    void admin;
    void student;

    await staffApi().delete(`/staff/schools/${school.id}`);
    const res = await staffApi().delete(
      `/staff/schools/${school.id}?permanent=true&confirm_label=${encodeURIComponent('École Alpha')}`,
    );

    expect(res.status).toBe(204);
    expect(await prisma.school.count({ where: { id: school.id } })).toBe(0);
    expect(await prisma.user.count({ where: { schoolId: school.id } })).toBe(0);
    expect(await prisma.student.count({ where: { schoolId: school.id } })).toBe(0);
    expect(await prisma.class.count({ where: { schoolId: school.id } })).toBe(0);
    expect(await prisma.term.count({ where: { schoolId: school.id } })).toBe(0);
    expect(await prisma.evaluation.count({ where: { schoolId: school.id } })).toBe(0);
  });

  it('refuse la suppression définitive sans suspension préalable', async () => {
    const school = await createSchool('ecole-a', 'École Alpha');
    const res = await staffApi().delete(
      `/staff/schools/${school.id}?permanent=true&confirm_label=${encodeURIComponent('École Alpha')}`,
    );
    expect(res.status).toBe(409);
    expect(await prisma.school.count({ where: { id: school.id } })).toBe(1);
  });

  it('refuse la suppression définitive si le nom retapé ne correspond pas', async () => {
    const school = await createSchool('ecole-a', 'École Alpha');
    await staffApi().delete(`/staff/schools/${school.id}`);

    const res = await staffApi().delete(
      `/staff/schools/${school.id}?permanent=true&confirm_label=${encodeURIComponent('Mauvais nom')}`,
    );
    expect(res.status).toBe(400);
    expect(await prisma.school.count({ where: { id: school.id } })).toBe(1);
  });

  it('refuse un token client sur les routes de gestion des écoles', async () => {
    const school = await createSchool('ecole-a');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const clientToken = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });

    expect((await staffApi(clientToken).delete(`/staff/schools/${school.id}`)).status).toBe(401);
    expect((await staffApi(clientToken).post(`/staff/schools/${school.id}/restore`)).status).toBe(401);
  });
});

describe('renvoyer l’invitation d’une école', () => {
  it('renvoie l’invitation au compte administrateur (email perdu, lien expiré)', async () => {
    const school = await createSchool('ecole-a', 'École Alpha');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const before = await prisma.passwordResetToken.count({ where: { userId: admin.id } });

    const res = await staffApi().post(`/staff/schools/${school.id}/invitation`);

    expect(res.status).toBe(200);
    const after = await prisma.passwordResetToken.count({ where: { userId: admin.id } });
    expect(after).toBe(before + 1);
  });

  it('refuse pour une école introuvable', async () => {
    const res = await staffApi().post('/staff/schools/999999/invitation');
    expect(res.status).toBe(404);
  });

  it('refuse quand l’école n’a aucun compte administrateur', async () => {
    const school = await createSchool('ecole-a');
    const res = await staffApi().post(`/staff/schools/${school.id}/invitation`);
    expect(res.status).toBe(404);
  });

  it('refuse un token client', async () => {
    const school = await createSchool('ecole-a');
    const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
    const clientToken = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });

    const res = await staffApi(clientToken).post(`/staff/schools/${school.id}/invitation`);
    expect(res.status).toBe(401);
  });
});
