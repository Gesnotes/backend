import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase, seedGrade } from './helpers';
import { createApp } from '../src/app';
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
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

const createGradeType = (label = 'Devoir 1', weight = 2, required = true) =>
  api(adminToken).post('/grade-types').send({ label, weight, required });

describe('CRUD /grade-types', () => {
  it("crée, liste et modifie un type de note — le référentiel n'est plus fermé", async () => {
    const created = await createGradeType();
    expect(created.status).toBe(201);
    expect(created.body.label).toBe('Devoir 1');
    expect(created.body.weight).toBe(2);
    expect(created.body.required).toBe(true);
    expect(created.body.position).toBeGreaterThan(0);

    const list = await api(adminToken).get('/grade-types');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const updated = await api(adminToken)
      .patch(`/grade-types/${created.body.id}`)
      .send({ label: 'Devoir maison', weight: 3, required: false });
    expect(updated.status).toBe(200);
    expect(updated.body.label).toBe('Devoir maison');
    expect(updated.body.weight).toBe(3);
    expect(updated.body.required).toBe(false);
  });

  it('réordonne via `position`', async () => {
    const a = await createGradeType('A', 1);
    const b = await createGradeType('B', 1);

    await api(adminToken).patch(`/grade-types/${a.body.id}`).send({ position: 5 });
    await api(adminToken).patch(`/grade-types/${b.body.id}`).send({ position: 1 });

    const list = await api(adminToken).get('/grade-types');
    expect(list.body.map((g: { label: string }) => g.label)).toEqual(['B', 'A']);
  });

  it('valide les entrées', async () => {
    expect((await api(adminToken).post('/grade-types').send({ label: '', weight: 2, required: true })).status).toBe(400);
    expect((await api(adminToken).post('/grade-types').send({ label: 'X', weight: -1, required: true })).status).toBe(400);
    expect((await api(adminToken).post('/grade-types').send({ label: 'X', weight: 2 })).status).toBe(400);
    expect((await api(adminToken).patch('/grade-types/1').send({})).status).toBe(400);
  });

  it('interdit la création et la modification à un enseignant, mais laisse la liste', async () => {
    expect((await api(teacherToken).post('/grade-types').send({ label: 'X', weight: 1, required: false })).status).toBe(403);
    expect((await api(teacherToken).get('/grade-types')).status).toBe(200);
  });

  it("refuse la liste à un parent — c'est un référentiel de saisie", async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'p@a.test', role: 'parent' });
    const parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });

    expect((await api(parentToken).get('/grade-types')).status).toBe(403);
  });

  it('refuse une requête sans token', async () => {
    expect((await request(app).get('/grade-types')).status).toBe(401);
  });

  it('dérive un code technique unique du libellé, jamais exposé à la saisie manuelle', async () => {
    const first = await createGradeType('Devoir');
    const second = await createGradeType('Devoir');

    expect(first.body.code).not.toBe(second.body.code);
  });
});

describe('isolation par école', () => {
  it("ne liste jamais les types de note d'une autre école", async () => {
    await createGradeType('Devoir A');
    await prisma.gradeType.create({
      data: { schoolId: schoolB.id, code: 'secret-b', label: 'Secret B', weight: 1, required: false },
    });

    const list = await api(adminToken).get('/grade-types');
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('Secret B');
  });

  it("renvoie 404 sur le type de note d'une autre école, même avec le bon id", async () => {
    const secret = await prisma.gradeType.create({
      data: { schoolId: schoolB.id, code: 'secret-b', label: 'Secret B', weight: 1, required: false },
    });

    expect((await api(adminToken).patch(`/grade-types/${secret.id}`).send({ label: 'Vole' })).status).toBe(404);
    expect((await api(adminToken).delete(`/grade-types/${secret.id}`)).status).toBe(404);

    const untouched = await prisma.gradeType.findUniqueOrThrow({ where: { id: secret.id } });
    expect(untouched.label).toBe('Secret B');
  });
});

describe('archivage et suppression', () => {
  it('archive par défaut et retire le type de note de la liste — même sans notes existantes', async () => {
    const { body } = await createGradeType();

    expect((await api(adminToken).delete(`/grade-types/${body.id}`)).status).toBe(204);
    expect((await api(adminToken).get('/grade-types')).body).toHaveLength(0);

    const withArchived = await api(adminToken).get('/grade-types?include_archived=true');
    expect(withArchived.body).toHaveLength(1);
    expect(withArchived.body[0].archivedAt).toBeTruthy();
  });

  it('archive un type de note déjà utilisé sans toucher aux notes existantes', async () => {
    const { body } = await createGradeType();
    const term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'T1' } });
    const subject = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Maths' } });
    const student = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: classA.id, firstName: 'Ana', lastName: 'K' },
    });
    await seedGrade({
      schoolId: schoolA.id,
      studentId: student.id,
      subjectId: subject.id,
      gradeTypeId: body.id,
      termId: term.id,
      value: 15,
    });

    expect((await api(adminToken).delete(`/grade-types/${body.id}`)).status).toBe(204);
    expect(await prisma.grade.count()).toBe(1);
  });

  it('restaure un type de note archivé', async () => {
    const { body } = await createGradeType();
    await api(adminToken).delete(`/grade-types/${body.id}`);

    expect((await api(adminToken).post(`/grade-types/${body.id}/restore`)).status).toBe(200);
    expect((await api(adminToken).get('/grade-types')).body).toHaveLength(1);
  });

  it('refuse la suppression définitive tant que le type de note n’est pas archivé', async () => {
    const { body } = await createGradeType();

    const res = await api(adminToken).delete(`/grade-types/${body.id}?permanent=true&confirm_label=Devoir%201`);
    expect(res.status).toBe(409);
    expect(await prisma.gradeType.count({ where: { id: body.id } })).toBe(1);
  });

  it('refuse la suppression définitive si la confirmation ne correspond pas au libellé', async () => {
    const { body } = await createGradeType();
    await api(adminToken).delete(`/grade-types/${body.id}`);

    const res = await api(adminToken).delete(`/grade-types/${body.id}?permanent=true&confirm_label=Autre`);
    expect(res.status).toBe(400);
    expect(await prisma.gradeType.count({ where: { id: body.id } })).toBe(1);
  });

  /**
   * Diverge du pattern période/matière : un type de note utilisé bloque sa
   * suppression définitive au lieu d'emporter ses notes en cascade — les FK
   * `grades.grade_type_id` / `evaluations.grade_type_id` sont d'ailleurs
   * restées en RESTRICT (voir la migration de ce champ).
   */
  it('refuse la suppression définitive tant que des notes référencent le type — pas de cascade', async () => {
    const { body } = await createGradeType();
    const term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'T1' } });
    const subject = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Maths' } });
    const student = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: classA.id, firstName: 'Ana', lastName: 'K' },
    });
    await seedGrade({
      schoolId: schoolA.id,
      studentId: student.id,
      subjectId: subject.id,
      gradeTypeId: body.id,
      termId: term.id,
      value: 15,
    });
    await api(adminToken).delete(`/grade-types/${body.id}`); // archive

    const res = await api(adminToken).delete(`/grade-types/${body.id}?permanent=true&confirm_label=Devoir%201`);
    expect(res.status).toBe(409);

    // Rien n'a été emporté : ni le type, ni la note.
    expect(await prisma.gradeType.count({ where: { id: body.id } })).toBe(1);
    expect(await prisma.grade.count()).toBe(1);
  });

  it('supprime définitivement un type de note archivé et inutilisé, avec le libellé exact', async () => {
    const { body } = await createGradeType();
    await api(adminToken).delete(`/grade-types/${body.id}`);

    const res = await api(adminToken).delete(`/grade-types/${body.id}?permanent=true&confirm_label=Devoir%201`);
    expect(res.status).toBe(204);
    expect(await prisma.gradeType.count()).toBe(0);
  });
});
