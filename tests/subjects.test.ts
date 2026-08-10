import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { TEST_PASSWORD, createSchool, createUser, resetDatabase, seedGrade } from './helpers';
import { createApp } from '../src/app';
import { resolveSubjectCoefficient } from '../src/services/subject.service';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let schoolB: { id: number };
let adminToken: string;
let teacherToken: string;
let adminBToken: string;
let classA: { id: number };

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });
  const adminB = await createUser({ schoolId: schoolB.id, email: 'admin@b.test', role: 'admin' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });
  adminBToken = signAccessToken({ userId: adminB.id, schoolId: schoolB.id, role: 'admin' });

  classA = await prisma.class.create({
    data: { schoolId: schoolA.id, name: '6e A', level: '6e' },
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${token}`),
  patch: (p: string) => request(app).patch(p).set('Authorization', `Bearer ${token}`),
  put: (p: string) => request(app).put(p).set('Authorization', `Bearer ${token}`),
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

const createSubject = (name = 'Maths', coefficient = 2) =>
  api(adminToken).post('/subjects').send({ name, coefficient });

describe('CRUD /subjects', () => {
  it('crée, liste et modifie une matière', async () => {
    const created = await createSubject();
    expect(created.status).toBe(201);

    const list = await api(adminToken).get('/subjects');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Maths');

    const updated = await api(adminToken).patch(`/subjects/${created.body.id}`).send({ name: 'Mathématiques' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Mathématiques');
  });

  it('valide les entrées', async () => {
    expect((await api(adminToken).post('/subjects').send({ name: '' })).status).toBe(400);
    expect((await api(adminToken).post('/subjects').send({ name: 'X', coefficient: -1 })).status).toBe(400);
    expect((await api(adminToken).patch('/subjects/1').send({})).status).toBe(400);
  });

  it('interdit la création à un enseignant', async () => {
    const res = await api(teacherToken).post('/subjects').send({ name: 'Physique' });
    expect(res.status).toBe(403);
  });

  it('laisse un enseignant consulter la liste', async () => {
    await createSubject();
    expect((await api(teacherToken).get('/subjects')).status).toBe(200);
  });

  it("REFUSE la liste à un parent — elle porte l'annuaire de l'équipe", async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });
    const parentToken = signAccessToken({
      userId: parent.id,
      schoolId: schoolA.id,
      role: 'parent',
    });

    expect((await api(parentToken).get('/subjects')).status).toBe(403);
  });

  it('refuse une requête sans token', async () => {
    expect((await request(app).get('/subjects')).status).toBe(401);
  });
});

describe('isolation par école', () => {
  it("ne liste jamais les matières d'une autre école", async () => {
    await createSubject('Maths');
    await prisma.subject.create({ data: { schoolId: schoolB.id, name: 'Secret B' } });

    const list = await api(adminToken).get('/subjects');
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('Secret B');
  });

  it("renvoie 404 sur la matière d'une autre école, même avec le bon id", async () => {
    const secret = await prisma.subject.create({ data: { schoolId: schoolB.id, name: 'Secret B' } });

    expect((await api(adminToken).patch(`/subjects/${secret.id}`).send({ name: 'Vole' })).status).toBe(404);
    expect((await api(adminToken).delete(`/subjects/${secret.id}`)).status).toBe(404);

    // La matière est intacte.
    const untouched = await prisma.subject.findUniqueOrThrow({ where: { id: secret.id } });
    expect(untouched.name).toBe('Secret B');
  });
});

describe('archivage et suppression', () => {
  it('archive par défaut et retire la matière de la liste', async () => {
    const { body } = await createSubject();

    expect((await api(adminToken).delete(`/subjects/${body.id}`)).status).toBe(204);
    expect((await api(adminToken).get('/subjects')).body).toHaveLength(0);

    // Toujours en base, et visible sur demande explicite.
    const withArchived = await api(adminToken).get('/subjects?include_archived=true');
    expect(withArchived.body).toHaveLength(1);
    expect(withArchived.body[0].archivedAt).toBeTruthy();
  });

  it('restaure une matière archivée', async () => {
    const { body } = await createSubject();
    await api(adminToken).delete(`/subjects/${body.id}`);

    expect((await api(adminToken).post(`/subjects/${body.id}/restore`)).status).toBe(200);
    expect((await api(adminToken).get('/subjects')).body).toHaveLength(1);
  });

  it('refuse la suppression définitive tant que la matière n’est pas archivée', async () => {
    const { body } = await createSubject();

    const res = await api(adminToken).delete(`/subjects/${body.id}?permanent=true&confirm_label=Maths`);
    expect(res.status).toBe(409);
    expect(await prisma.subject.count({ where: { id: body.id } })).toBe(1);
  });

  it('refuse la suppression définitive si la confirmation ne correspond pas au nom', async () => {
    const { body } = await createSubject();
    await api(adminToken).delete(`/subjects/${body.id}`);

    const res = await api(adminToken).delete(`/subjects/${body.id}?permanent=true&confirm_label=Autre`);
    expect(res.status).toBe(400);
    expect(await prisma.subject.count({ where: { id: body.id } })).toBe(1);
  });

  it('supprime définitivement une matière archivée et sans note, avec le nom exact', async () => {
    const { body } = await createSubject();
    await api(adminToken).delete(`/subjects/${body.id}`);

    const res = await api(adminToken).delete(`/subjects/${body.id}?permanent=true&confirm_label=Maths`);
    expect(res.status).toBe(204);
    expect(await prisma.subject.count()).toBe(0);
  });

  it('emporte en cascade les évaluations et les notes', async () => {
    const { body } = await createSubject();
    await api(adminToken).delete(`/subjects/${body.id}`);

    const term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'T1' } });
    const gradeType = await prisma.gradeType.create({
      data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2 },
    });
    const student = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: classA.id, firstName: 'Ana', lastName: 'K' },
    });
    await seedGrade({
      schoolId: schoolA.id,
      studentId: student.id,
      subjectId: body.id,
      gradeTypeId: gradeType.id,
      termId: term.id,
      value: 15,
    });

    const res = await api(adminToken).delete(`/subjects/${body.id}?permanent=true&confirm_label=Maths`);
    expect(res.status).toBe(204);

    // La note et l'évaluation qui la portait ont été emportées avec la matière.
    expect(await prisma.grade.count()).toBe(0);
    expect(await prisma.evaluation.count()).toBe(0);
  });
});

describe('coefficients par classe (plan §2.4)', () => {
  it('définit, remplace et supprime la surcharge de classe', async () => {
    const { body } = await createSubject('Maths', 2);

    const set = await api(adminToken).put(`/subjects/${body.id}/coefficients/${classA.id}`).send({ coefficient: 4 });
    expect(set.status).toBe(200);

    // Idempotent : un second appel remplace au lieu de créer un doublon.
    await api(adminToken).put(`/subjects/${body.id}/coefficients/${classA.id}`).send({ coefficient: 5 });
    expect(await prisma.subjectCoefficient.count()).toBe(1);
    expect(Number(await resolveSubjectCoefficient(schoolA.id, body.id, classA.id))).toBe(5);

    expect((await api(adminToken).delete(`/subjects/${body.id}/coefficients/${classA.id}`)).status).toBe(204);
  });

  it('retombe sur le coefficient de l\'école sans surcharge', async () => {
    const { body } = await createSubject('Maths', 3);
    expect(Number(await resolveSubjectCoefficient(schoolA.id, body.id, classA.id))).toBe(3);
  });

  it("refuse de résoudre le coefficient d'une matière d'une autre école", async () => {
    const { body } = await createSubject('Maths', 3);
    await expect(resolveSubjectCoefficient(schoolB.id, body.id, classA.id)).rejects.toThrow();
  });

  it("refuse de poser un coefficient sur la classe d'une autre école", async () => {
    const { body } = await createSubject();
    const classB = await prisma.class.create({
      data: { schoolId: schoolB.id, name: '6e B', level: '6e' },
    });

    const res = await api(adminToken).put(`/subjects/${body.id}/coefficients/${classB.id}`).send({ coefficient: 4 });
    expect(res.status).toBe(404);
    expect(await prisma.subjectCoefficient.count()).toBe(0);
  });

  it('expose les coefficients et les enseignants dans la liste', async () => {
    const { body } = await createSubject();
    await api(adminToken).put(`/subjects/${body.id}/coefficients/${classA.id}`).send({ coefficient: 4 });

    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: teacher.id, classId: classA.id, subjectId: body.id },
    });

    const list = await api(adminToken).get('/subjects');
    expect(list.body[0].coefficientsParClasse).toHaveLength(1);
    expect(list.body[0].coefficientsParClasse[0].coefficient).toBe('4');
    expect(list.body[0].enseignants).toHaveLength(1);
    // L'email a ete retire : cette liste dit qui enseigne quoi, elle ne
    // diffuse pas l'annuaire de l'equipe.
    expect(list.body[0].enseignants[0]).not.toHaveProperty('email');
  });

  it('ne renvoie jamais de hash de mot de passe', async () => {
    const { body } = await createSubject();
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: teacher.id, classId: classA.id, subjectId: body.id },
    });

    const list = await api(adminToken).get('/subjects');
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
    expect(JSON.stringify(list.body)).not.toContain('$argon2');
  });
});

describe('unicité du nom de matière', () => {
  it('refuse un nom déjà utilisé', async () => {
    await createSubject('Mathématiques');
    const res = await api(adminToken).post('/subjects').send({ name: 'Mathématiques' });
    expect(res.status).toBe(409);
  });

  /**
   * Le cœur du problème signalé : « Mathématiques » et « Mathematiques »
   * désignent la même matière, mais restaient deux lignes distinctes.
   */
  it('refuse un quasi-doublon ne différant que par les accents ou la casse', async () => {
    await createSubject('Mathématiques');

    expect((await api(adminToken).post('/subjects').send({ name: 'Mathematiques' })).status).toBe(409);
    expect((await api(adminToken).post('/subjects').send({ name: 'MATHÉMATIQUES' })).status).toBe(409);
    expect((await api(adminToken).post('/subjects').send({ name: '  Mathématiques  ' })).status).toBe(409);

    // Une seule matière a bien été créée.
    expect((await api(adminToken).get('/subjects')).body).toHaveLength(1);
  });

  it('laisse deux écoles utiliser le même nom', async () => {
    await createSubject('Mathématiques');
    const res = await api(adminBToken).post('/subjects').send({ name: 'Mathématiques' });
    expect(res.status).toBe(201);
  });

  it('signale un doublon avec une matière archivée et invite à la restaurer', async () => {
    const created = await createSubject('Mathématiques');
    await api(adminToken).delete(`/subjects/${created.body.id}`); // archive

    const res = await api(adminToken).post('/subjects').send({ name: 'Mathematiques' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.archived).toBe(true);
  });

  it('autorise une matière à conserver son propre nom lors d’une modification', async () => {
    const created = await createSubject('Mathématiques', 3);
    const res = await api(adminToken)
      .patch(`/subjects/${created.body.id}`)
      .send({ name: 'Mathématiques', coefficient: 4 });
    expect(res.status).toBe(200);
    expect(Number(res.body.coefficient)).toBe(4);
  });

  it('empêche une modification de percuter une autre matière', async () => {
    await createSubject('Mathématiques');
    const physique = await createSubject('Physique');

    const res = await api(adminToken)
      .patch(`/subjects/${physique.body.id}`)
      .send({ name: 'mathematiques' });
    expect(res.status).toBe(409);
  });
});
