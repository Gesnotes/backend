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
let classA: { id: number };
let subjectA: { id: number };

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });

  classA = await prisma.class.create({ data: { schoolId: schoolA.id, name: '6e A', level: '6e' } });
  subjectA = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Maths' } });
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

const newTeacher = (email = 'nouveau@a.test', assignments?: unknown[]) =>
  api(adminToken).post('/teachers').send({
    email,
    firstName: 'Jean',
    lastName: 'Koffi',
    phone: '97 11 22 33',
    ...(assignments ? { assignments } : {}),
  });

describe('POST /teachers', () => {
  it('crée le compte et ses affectations en un appel', async () => {
    const classB = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e' },
    });
    const res = await newTeacher('jean@a.test', [
      { classId: classA.id, subjectId: subjectA.id },
      { classId: classB.id, subjectId: subjectA.id },
    ]);

    expect(res.status).toBe(201);
    expect(res.body.affectations).toHaveLength(2);
    expect(res.body.phone).toBe('97112233'); // normalisé
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it("n'accepte aucun mot de passe et envoie une invitation", async () => {
    const res = await newTeacher('jean@a.test');
    expect(res.status).toBe(201);

    // Un token d'invitation existe, le compte n'est pas utilisable avant.
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'jean@a.test' } });
    expect(await prisma.passwordResetToken.count({ where: { userId: teacher.id } })).toBe(1);

    const login = await request(app)
      .post('/auth/identify')
      .send({ identifier: 'jean@a.test', password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });

  it('refuse un email déjà utilisé dans la même école', async () => {
    await newTeacher('jean@a.test');
    const duplicate = await newTeacher('jean@a.test');
    expect(duplicate.status).toBe(409);
  });

  it('accepte le même email dans une autre école', async () => {
    await newTeacher('jean@a.test');
    await expect(
      createUser({ schoolId: schoolB.id, email: 'jean@a.test', role: 'teacher' }),
    ).resolves.toBeTruthy();
  });

  it("refuse une affectation vers la classe d'une autre école", async () => {
    const classB = await prisma.class.create({
      data: { schoolId: schoolB.id, name: '6e B', level: '6e' },
    });

    const res = await newTeacher('jean@a.test', [{ classId: classB.id, subjectId: subjectA.id }]);
    expect(res.status).toBe(404);

    // Transaction : aucun compte orphelin n'a été laissé derrière.
    expect(await prisma.user.count({ where: { email: 'jean@a.test' } })).toBe(0);
  });

  it("refuse une affectation vers la matière d'une autre école", async () => {
    const subjectB = await prisma.subject.create({ data: { schoolId: schoolB.id, name: 'Secret' } });
    const res = await newTeacher('jean@a.test', [{ classId: classA.id, subjectId: subjectB.id }]);
    expect(res.status).toBe(404);
  });

  it('ignore les affectations dupliquées', async () => {
    const res = await newTeacher('jean@a.test', [
      { classId: classA.id, subjectId: subjectA.id },
      { classId: classA.id, subjectId: subjectA.id },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.affectations).toHaveLength(1);
  });

  it('interdit la création à un enseignant', async () => {
    const res = await api(teacherToken).post('/teachers').send({ email: 'x@a.test' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /teachers/:id', () => {
  it('remplace intégralement les affectations', async () => {
    const created = await newTeacher('jean@a.test', [
      { classId: classA.id, subjectId: subjectA.id },
    ]);

    const other = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e' },
    });
    const res = await api(adminToken)
      .patch(`/teachers/${created.body.id}`)
      .send({ assignments: [{ classId: other.id, subjectId: subjectA.id }] });

    expect(res.status).toBe(200);
    expect(res.body.affectations).toHaveLength(1);
    expect(res.body.affectations[0].classId).toBe(other.id);
  });

  it('laisse les affectations intactes si le champ est absent', async () => {
    const created = await newTeacher('jean@a.test', [
      { classId: classA.id, subjectId: subjectA.id },
    ]);

    const res = await api(adminToken)
      .patch(`/teachers/${created.body.id}`)
      .send({ firstName: 'Jeanne' });

    expect(res.body.firstName).toBe('Jeanne');
    expect(res.body.affectations).toHaveLength(1);
  });

  it('refuse un email déjà pris par un autre compte de l\'école', async () => {
    const created = await newTeacher('jean@a.test');
    const res = await api(adminToken).patch(`/teachers/${created.body.id}`).send({ email: 'admin@a.test' });
    expect(res.status).toBe(409);
  });

  it('renvoie 404 pour un enseignant d\'une autre école', async () => {
    const foreign = await createUser({ schoolId: schoolB.id, email: 'prof@b.test', role: 'teacher' });
    const res = await api(adminToken).patch(`/teachers/${foreign.id}`).send({ firstName: 'Vole' });
    expect(res.status).toBe(404);
  });

  it('ne permet pas de cibler un parent via cette route', async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });
    const res = await api(adminToken).patch(`/teachers/${parent.id}`).send({ firstName: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('désactivation', () => {
  it('archive le compte en conservant les notes saisies', async () => {
    const created = await newTeacher('jean@a.test');
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
      subjectId: subjectA.id,
      gradeTypeId: gradeType.id,
      termId: term.id,
      teacherUserId: created.body.id,
      value: 15,
    });

    expect((await api(adminToken).delete(`/teachers/${created.body.id}`)).status).toBe(204);

    expect(await prisma.grade.count()).toBe(1);
    expect((await api(adminToken).get('/teachers')).body.map((t: { email: string }) => t.email)).not.toContain('jean@a.test');
    expect((await api(adminToken).get('/teachers?include_archived=true')).body).toHaveLength(2);
  });

  it('coupe immédiatement la session de l\'enseignant désactivé', async () => {
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    expect((await api(teacherToken).get('/subjects')).status).toBe(200);

    await api(adminToken).delete(`/teachers/${teacher.id}`);

    // Sans revokeAllSessions, le token resterait valable 30 jours.
    expect((await api(teacherToken).get('/subjects')).status).toBe(401);
  });

  it('empêche un compte archivé de se reconnecter', async () => {
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await api(adminToken).delete(`/teachers/${teacher.id}`);

    const login = await request(app)
      .post('/auth/identify')
      .send({ identifier: 'prof@a.test', password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });

  it('restaure un compte archivé', async () => {
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await api(adminToken).delete(`/teachers/${teacher.id}`);

    expect((await api(adminToken).get('/teachers')).body).toHaveLength(0);

    expect((await api(adminToken).post(`/teachers/${teacher.id}/restore`)).status).toBe(200);
    expect((await api(adminToken).get('/teachers')).body).toHaveLength(1);
  });

  it("désolidarise l'auteur des notes déjà saisies plutôt que de refuser la suppression", async () => {
    const created = await newTeacher('jean@a.test');
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
      subjectId: subjectA.id,
      gradeTypeId: gradeType.id,
      termId: term.id,
      teacherUserId: created.body.id,
      value: 15,
    });

    await api(adminToken).delete(`/teachers/${created.body.id}`);

    const res = await api(adminToken).delete(
      `/teachers/${created.body.id}?permanent=true&confirm_label=Jean Koffi`,
    );
    expect(res.status).toBe(204);
    expect(await prisma.grade.count()).toBe(1);
    const grade = await prisma.grade.findFirstOrThrow();
    expect(grade.teacherUserId).toBeNull();
  });

  it("désolidarise l'auteur des présences déjà saisies plutôt que de refuser la suppression", async () => {
    const created = await newTeacher('jean@a.test');
    const student = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: classA.id, firstName: 'Ana', lastName: 'K' },
    });
    await prisma.attendance.create({
      data: {
        schoolId: schoolA.id,
        studentId: student.id,
        classId: classA.id,
        date: new Date('2026-01-15'),
        status: 'present',
        recordedByUserId: created.body.id,
      },
    });

    await api(adminToken).delete(`/teachers/${created.body.id}`);

    const res = await api(adminToken).delete(
      `/teachers/${created.body.id}?permanent=true&confirm_label=Jean Koffi`,
    );
    expect(res.status).toBe(204);
    expect(await prisma.attendance.count()).toBe(1);
    const attendance = await prisma.attendance.findFirstOrThrow();
    expect(attendance.recordedByUserId).toBeNull();
  });

  it('détache la classe dont il est référent plutôt que de refuser la suppression', async () => {
    const created = await newTeacher('jean@a.test');
    await prisma.class.update({
      where: { id: classA.id },
      data: { homeroomTeacherId: created.body.id },
    });

    await api(adminToken).delete(`/teachers/${created.body.id}`);

    const res = await api(adminToken).delete(
      `/teachers/${created.body.id}?permanent=true&confirm_label=Jean Koffi`,
    );
    expect(res.status).toBe(204);
    const updatedClass = await prisma.class.findUniqueOrThrow({ where: { id: classA.id } });
    expect(updatedClass.homeroomTeacherId).toBeNull();
  });

  it('refuse la suppression définitive tant que le compte n’est pas archivé', async () => {
    const created = await newTeacher('jean@a.test');

    const res = await api(adminToken).delete(
      `/teachers/${created.body.id}?permanent=true&confirm_label=Jean Koffi`,
    );
    expect(res.status).toBe(409);
    expect(await prisma.user.count({ where: { id: created.body.id } })).toBe(1);
  });

  it('refuse la suppression définitive si la confirmation ne correspond pas au nom', async () => {
    const created = await newTeacher('jean@a.test');
    await api(adminToken).delete(`/teachers/${created.body.id}`);

    const res = await api(adminToken).delete(
      `/teachers/${created.body.id}?permanent=true&confirm_label=Mauvais nom`,
    );
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { id: created.body.id } })).toBe(1);
  });

  it('supprime définitivement un compte archivé et sans note, avec le nom exact', async () => {
    const created = await newTeacher('jean@a.test', [
      { classId: classA.id, subjectId: subjectA.id },
    ]);
    await api(adminToken).delete(`/teachers/${created.body.id}`);

    const res = await api(adminToken).delete(
      `/teachers/${created.body.id}?permanent=true&confirm_label=Jean Koffi`,
    );
    expect(res.status).toBe(204);
    expect(await prisma.user.count({ where: { email: 'jean@a.test' } })).toBe(0);
    // Les affectations partent en cascade.
    expect(await prisma.teacherAssignment.count()).toBe(0);
  });
});

describe('GET /teachers', () => {
  it('liste les enseignants avec leurs affectations, sans hash', async () => {
    await newTeacher('jean@a.test', [{ classId: classA.id, subjectId: subjectA.id }]);

    const res = await api(adminToken).get('/teachers');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('$argon2');

    const jean = res.body.find((t: { email: string }) => t.email === 'jean@a.test');
    expect(jean.affectations[0].subjectName).toBe('Maths');
    expect(jean.affectations[0].className).toBe('6e A');
  });

  it('ne liste que les enseignants, pas les parents ni les admins', async () => {
    await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });
    const res = await api(adminToken).get('/teachers');
    const emails = res.body.map((t: { email: string }) => t.email);
    expect(emails).toEqual(['prof@a.test']);
  });

  it('interdit la liste à un enseignant', async () => {
    expect((await api(teacherToken).get('/teachers')).status).toBe(403);
  });
});
