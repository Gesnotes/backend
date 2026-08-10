import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { TEST_PASSWORD, createSchool, createUser, resetDatabase, seedGrade } from './helpers';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let schoolB: { id: number };
let adminToken: string;
let teacherToken: string;
let klass: { id: number };

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });
  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });

  klass = await prisma.class.create({ data: { schoolId: schoolA.id, name: '6e A', level: '6e' } });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  patch: (p: string) => request(app).patch(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  delete: (p: string) => request(app).delete(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
});

const newStudent = (firstName = 'Ana', lastName = 'Alpha') =>
  api(adminToken).post('/students').send({ firstName, lastName, classId: klass.id });

describe('CRUD /students', () => {
  it('crée, liste et modifie un élève', async () => {
    const created = await newStudent();
    expect(created.status).toBe(201);
    expect(created.body.classe.name).toBe('6e A');

    expect((await api(adminToken).get('/students')).body.students).toHaveLength(1);

    const updated = await api(adminToken).patch(`/students/${created.body.id}`).send({ lastName: 'Beta' });
    expect(updated.body.lastName).toBe('Beta');
  });

  it('change un élève de classe', async () => {
    const created = await newStudent();
    const autre = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e' },
    });

    const res = await api(adminToken).patch(`/students/${created.body.id}`).send({ classId: autre.id });
    expect(res.body.classe.id).toBe(autre.id);
  });

  it('refuse d’inscrire un élève dans une classe archivée', async () => {
    const archived = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e', archivedAt: new Date() },
    });

    const res = await api(adminToken)
      .post('/students')
      .send({ firstName: 'Ana', lastName: 'Alpha', classId: archived.id });

    expect(res.status).toBe(409);
    expect(await prisma.student.count()).toBe(0);
  });

  it('refuse de déplacer un élève vers une classe archivée', async () => {
    const created = await newStudent();
    const archived = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e', archivedAt: new Date() },
    });

    const res = await api(adminToken).patch(`/students/${created.body.id}`).send({ classId: archived.id });

    expect(res.status).toBe(409);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: created.body.id } })).classId).toBe(
      klass.id,
    );
  });

  it('filtre par classe', async () => {
    await newStudent();
    const autre = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e' },
    });
    await prisma.student.create({
      data: { schoolId: schoolA.id, classId: autre.id, firstName: 'Ben', lastName: 'Beta' },
    });

    expect((await api(adminToken).get(`/students?class_id=${klass.id}`)).body.students).toHaveLength(1);
  });

  it("refuse une classe d'une autre école", async () => {
    const foreign = await prisma.class.create({
      data: { schoolId: schoolB.id, name: '6e B', level: '6e' },
    });
    const res = await api(adminToken)
      .post('/students')
      .send({ firstName: 'Ana', lastName: 'Alpha', classId: foreign.id });

    expect(res.status).toBe(404);
    expect(await prisma.student.count()).toBe(0);
  });

  it('interdit la création à un enseignant', async () => {
    const res = await api(teacherToken)
      .post('/students')
      .send({ firstName: 'Ana', lastName: 'Alpha', classId: klass.id });
    expect(res.status).toBe(403);
  });

  it("renvoie 404 sur l'élève d'une autre école", async () => {
    const foreignClass = await prisma.class.create({
      data: { schoolId: schoolB.id, name: '6e B', level: '6e' },
    });
    const foreign = await prisma.student.create({
      data: { schoolId: schoolB.id, classId: foreignClass.id, firstName: 'X', lastName: 'Y' },
    });

    expect((await api(adminToken).get(`/students/${foreign.id}`)).status).toBe(404);
    expect((await api(adminToken).patch(`/students/${foreign.id}`).send({ firstName: 'Vole' })).status).toBe(404);
  });
});

describe('périmètre de lecture', () => {
  it('REFUSE à un parent la liste des élèves et des coordonnées des familles', async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });
    const parentToken = signAccessToken({
      userId: parent.id,
      schoolId: schoolA.id,
      role: 'parent',
    });

    // Sans ce garde, n'importe quel parent récupérait l'annuaire complet des
    // familles de l'établissement : email et téléphone de chaque parent.
    expect((await api(parentToken).get('/students')).status).toBe(403);

    const created = await newStudent();
    expect((await api(parentToken).get(`/students/${created.body.id}`)).status).toBe(403);
  });

  it("borne l'enseignant aux classes où il enseigne", async () => {
    const autre = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e' },
    });
    const subject = await prisma.subject.create({
      data: { schoolId: schoolA.id, name: 'Maths' },
    });
    const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: prof.id, classId: klass.id, subjectId: subject.id },
    });

    const sien = await newStudent('Ana', 'Alpha');
    const horsPerimetre = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: autre.id, firstName: 'Ben', lastName: 'Beta' },
    });

    const liste = await api(teacherToken).get('/students');
    expect(liste.status).toBe(200);
    expect(liste.body.students.map((s: { id: number }) => s.id)).toEqual([sien.body.id]);

    // Un élève d'une classe qu'il n'enseigne pas est introuvable, pas interdit.
    expect((await api(teacherToken).get(`/students/${horsPerimetre.id}`)).status).toBe(404);
  });

  it("masque les coordonnées des parents à l'enseignant", async () => {
    const subject = await prisma.subject.create({
      data: { schoolId: schoolA.id, name: 'Maths' },
    });
    const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: prof.id, classId: klass.id, subjectId: subject.id },
    });

    const created = await newStudent();
    const parent = await createUser({
      schoolId: schoolA.id,
      email: 'contact@a.test',
      phone: '97000000',
      role: 'parent',
    });
    await api(adminToken).post(`/students/${created.body.id}/parents`).send({ parentUserId: parent.id });

    const vueProf = await api(teacherToken).get('/students');
    expect(JSON.stringify(vueProf.body)).not.toContain('contact@a.test');
    expect(JSON.stringify(vueProf.body)).not.toContain('97000000');

    // L'administration, elle, en a besoin pour joindre les familles.
    const vueAdmin = await api(adminToken).get('/students');
    expect(JSON.stringify(vueAdmin.body)).toContain('contact@a.test');
  });

  it('pagine la liste', async () => {
    const liste = await api(adminToken).get('/students');
    expect(liste.body).toMatchObject({ total: 0, page: 1, pageSize: 100 });
  });
});

describe('archivage et suppression définitive', () => {
  it('archive par défaut et conserve les notes', async () => {
    const created = await newStudent();
    const term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'T1' } });
    const subject = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Maths' } });
    const gradeType = await prisma.gradeType.create({
      data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2 },
    });
    await seedGrade({
      schoolId: schoolA.id,
      studentId: created.body.id,
      subjectId: subject.id,
      gradeTypeId: gradeType.id,
      termId: term.id,
      value: 15,
    });

    expect((await api(adminToken).delete(`/students/${created.body.id}`)).status).toBe(204);
    expect((await api(adminToken).get('/students')).body.students).toHaveLength(0);
    expect((await api(adminToken).get('/students?include_archived=true')).body.students).toHaveLength(1);
    expect(await prisma.grade.count()).toBe(1);

    expect((await api(adminToken).post(`/students/${created.body.id}/restore`)).status).toBe(200);
    expect((await api(adminToken).get('/students')).body.students).toHaveLength(1);
  });

  it('exige le nom exact pour une suppression définitive', async () => {
    const created = await newStudent('Ana', 'Alpha');

    const sansConfirmation = await api(adminToken).delete(`/students/${created.body.id}?permanent=true`);
    expect(sansConfirmation.status).toBe(400);

    const mauvaisNom = await api(adminToken).delete(
      `/students/${created.body.id}?permanent=true&confirm_name=Ben Beta`,
    );
    expect(mauvaisNom.status).toBe(400);

    // L'élève est toujours là après deux tentatives ratées.
    expect(await prisma.student.count()).toBe(1);
  });

  it('supprime en cascade les notes et les liens parents', async () => {
    const created = await newStudent('Ana', 'Alpha');
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });
    await api(adminToken).post(`/students/${created.body.id}/parents`).send({ parentUserId: parent.id });

    const term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'T1' } });
    const subject = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Maths' } });
    const gradeType = await prisma.gradeType.create({
      data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2 },
    });
    await seedGrade({
      schoolId: schoolA.id,
      studentId: created.body.id,
      subjectId: subject.id,
      gradeTypeId: gradeType.id,
      termId: term.id,
      value: 15,
    });

    const res = await api(adminToken).delete(
      `/students/${created.body.id}?permanent=true&confirm_name=${encodeURIComponent('Ana Alpha')}`,
    );
    expect(res.status).toBe(204);

    expect(await prisma.student.count()).toBe(0);
    expect(await prisma.grade.count()).toBe(0);
    expect(await prisma.studentParent.count()).toBe(0);
    // Le compte parent, lui, survit : il peut avoir d'autres enfants.
    expect(await prisma.user.count({ where: { id: parent.id } })).toBe(1);
  });
});

describe('GET /parents/search', () => {
  beforeEach(async () => {
    await createUser({
      schoolId: schoolA.id,
      email: 'marie.kouassi@a.test',
      phone: '97 11 22 33',
      role: 'parent',
    });
    await prisma.user.updateMany({
      where: { email: 'marie.kouassi@a.test' },
      data: { firstName: 'Marie', lastName: 'Kouassi' },
    });
  });

  it('trouve par email, téléphone et nom', async () => {
    for (const q of ['marie.kouassi', '97112233', 'Kouassi', 'marie']) {
      const res = await api(adminToken).get(`/parents/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    }
  });

  it('trouve un téléphone saisi avec des espaces', async () => {
    const res = await api(adminToken).get(`/parents/search?q=${encodeURIComponent('97 11 22 33')}`);
    expect(res.body).toHaveLength(1);
  });

  it("ne renvoie jamais un parent d'une autre école", async () => {
    await createUser({ schoolId: schoolB.id, email: 'marie.kouassi@b.test', role: 'parent' });

    const res = await api(adminToken).get('/parents/search?q=marie.kouassi');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].email).toBe('marie.kouassi@a.test');
  });

  it('ne renvoie ni enseignants ni administrateurs', async () => {
    const res = await api(adminToken).get('/parents/search?q=a.test');
    expect(res.body.map((p: { email: string }) => p.email)).toEqual(['marie.kouassi@a.test']);
  });

  it('ne divulgue aucun hash', async () => {
    const res = await api(adminToken).get('/parents/search?q=marie');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('$argon2');
  });

  it('est réservée à l\'administration', async () => {
    expect((await api(teacherToken).get('/parents/search?q=marie')).status).toBe(403);
  });
});

describe('association parent ↔ élève', () => {
  it('associe un parent existant', async () => {
    const created = await newStudent();
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });

    const res = await api(adminToken)
      .post(`/students/${created.body.id}/parents`)
      .send({ parentUserId: parent.id });

    expect(res.status).toBe(201);
    expect(res.body.parents).toHaveLength(1);
    expect(res.body.parents[0].email).toBe('p@a.test');
  });

  it('crée un compte parent par invitation, sans mot de passe dans le payload', async () => {
    const created = await newStudent();

    const res = await api(adminToken)
      .post(`/students/${created.body.id}/parents`)
      .send({ email: 'Nouveau.Parent@A.test', firstName: 'Kofi', phone: '97 44 55 66' });

    expect(res.status).toBe(201);
    expect(res.body.parents[0].email).toBe('nouveau.parent@a.test'); // normalisé
    expect(res.body.parents[0].phone).toBe('97445566');

    const parent = await prisma.user.findFirstOrThrow({ where: { email: 'nouveau.parent@a.test' } });
    expect(parent.role).toBe('parent');
    // Un lien d'invitation a été émis, et le compte n'est pas connectable avant.
    expect(await prisma.passwordResetToken.count({ where: { userId: parent.id } })).toBe(1);

    const login = await request(app)
      .post('/auth/login')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ identifier: 'nouveau.parent@a.test', password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });

  it('accepte plusieurs parents pour un même enfant', async () => {
    const created = await newStudent();
    const pere = await createUser({ schoolId: schoolA.id, email: 'pere@a.test', role: 'parent' });
    const mere = await createUser({ schoolId: schoolA.id, email: 'mere@a.test', role: 'parent' });

    await api(adminToken).post(`/students/${created.body.id}/parents`).send({ parentUserId: pere.id });
    const res = await api(adminToken)
      .post(`/students/${created.body.id}/parents`)
      .send({ parentUserId: mere.id });

    expect(res.body.parents).toHaveLength(2);
  });

  it('refuse une association en double', async () => {
    const created = await newStudent();
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });

    await api(adminToken).post(`/students/${created.body.id}/parents`).send({ parentUserId: parent.id });
    const second = await api(adminToken)
      .post(`/students/${created.body.id}/parents`)
      .send({ parentUserId: parent.id });

    expect(second.status).toBe(409);
  });

  it("refuse un parent d'une autre école", async () => {
    const created = await newStudent();
    const foreign = await createUser({ schoolId: schoolB.id, email: 'p@b.test', role: 'parent' });

    const res = await api(adminToken)
      .post(`/students/${created.body.id}/parents`)
      .send({ parentUserId: foreign.id });

    expect(res.status).toBe(404);
    expect(await prisma.studentParent.count()).toBe(0);
  });

  it('refuse de transformer un enseignant en parent', async () => {
    const created = await newStudent();
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });

    const res = await api(adminToken)
      .post(`/students/${created.body.id}/parents`)
      .send({ parentUserId: teacher.id });
    expect(res.status).toBe(404);
  });

  it('oriente vers le compte existant si l\'email est déjà pris', async () => {
    const created = await newStudent();
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });

    const res = await api(adminToken)
      .post(`/students/${created.body.id}/parents`)
      .send({ email: 'p@a.test' });

    expect(res.status).toBe(409);
    expect(res.body.error.details.parentUserId).toBe(parent.id);
  });

  it('dissocie un parent sans supprimer son compte', async () => {
    const created = await newStudent();
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });
    await api(adminToken).post(`/students/${created.body.id}/parents`).send({ parentUserId: parent.id });

    const res = await api(adminToken).delete(`/students/${created.body.id}/parents/${parent.id}`);
    expect(res.status).toBe(200);
    expect(res.body.parents).toHaveLength(0);
    expect(await prisma.user.count({ where: { id: parent.id } })).toBe(1);
  });

  it('renvoie 404 si le parent n\'était pas associé', async () => {
    const created = await newStudent();
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });

    const res = await api(adminToken).delete(`/students/${created.body.id}/parents/${parent.id}`);
    expect(res.status).toBe(404);
  });
});
