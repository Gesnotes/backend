import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let schoolB: { id: number };
let adminToken: string;
let teacherToken: string;
let parentToken: string;
let classSource: { id: number };
let classTarget: { id: number };
let students: { id: number }[];

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });

  classSource = await prisma.class.create({ data: { schoolId: schoolA.id, name: 'CP', level: 'CP' } });
  classTarget = await prisma.class.create({ data: { schoolId: schoolA.id, name: 'CE1', level: 'CE1' } });
  await prisma.class.update({ where: { id: classSource.id }, data: { promotesToId: classTarget.id } });

  students = [];
  for (const name of ['Adjovi', 'Kossi', 'Mawuena']) {
    students.push(
      await prisma.student.create({
        data: { schoolId: schoolA.id, classId: classSource.id, firstName: name, lastName: 'Test' },
      }),
    );
  }
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
});

const batch = (
  entries: { studentId: number; toClassId: number; decision: 'promotion' | 'redoublement' | 'autre' }[],
) => ({ entries });

describe('POST /classes/:id/enrollment-decisions', () => {
  it('déplace les élèves vers la classe de destination et trace la décision', async () => {
    const res = await api(adminToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch(students.map((s) => ({ studentId: s.id, toClassId: classTarget.id, decision: 'promotion' }))));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moved: 3, skipped: [] });

    for (const student of students) {
      const updated = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(updated.classId).toBe(classTarget.id);
    }

    const decisions = await prisma.enrollmentDecision.findMany({ where: { fromClassId: classSource.id } });
    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.decision === 'promotion')).toBe(true);
    expect(decisions.every((d) => d.toClassId === classTarget.id)).toBe(true);
  });

  it('accepte des décisions différentes selon les élèves', async () => {
    const redoublant = await prisma.class.create({ data: { schoolId: schoolA.id, name: 'CP bis', level: 'CP' } });

    const res = await api(adminToken).post(`/classes/${classSource.id}/enrollment-decisions`).send(
      batch([
        { studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' },
        { studentId: students[1]!.id, toClassId: redoublant.id, decision: 'redoublement' },
        { studentId: students[2]!.id, toClassId: classTarget.id, decision: 'autre' },
      ]),
    );

    expect(res.body.moved).toBe(3);
    const byStudent = new Map(
      (await prisma.enrollmentDecision.findMany({})).map((d) => [d.studentId, d.decision]),
    );
    expect(byStudent.get(students[0]!.id)).toBe('promotion');
    expect(byStudent.get(students[1]!.id)).toBe('redoublement');
    expect(byStudent.get(students[2]!.id)).toBe('autre');
  });

  it('refuse un enseignant', async () => {
    const res = await api(teacherToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' }]));
    expect(res.status).toBe(403);
  });

  it('refuse un parent', async () => {
    const res = await api(parentToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' }]));
    expect(res.status).toBe(403);
  });

  it('refuse une classe source inconnue', async () => {
    const res = await api(adminToken)
      .post('/classes/999999/enrollment-decisions')
      .send(batch([{ studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' }]));
    expect(res.status).toBe(404);
  });

  it('refuse une classe de destination inconnue', async () => {
    const res = await api(adminToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[0]!.id, toClassId: 999999, decision: 'promotion' }]));
    expect(res.status).toBe(404);
    expect(await prisma.enrollmentDecision.count()).toBe(0);
  });

  it('refuse une classe de destination archivée', async () => {
    await prisma.class.update({ where: { id: classTarget.id }, data: { archivedAt: new Date() } });

    const res = await api(adminToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' }]));

    expect(res.status).toBe(409);
    expect(await prisma.enrollmentDecision.count()).toBe(0);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: students[0]!.id } })).classId).toBe(
      classSource.id,
    );
  });

  it("refuse une classe de destination d'une autre école", async () => {
    const foreign = await prisma.class.create({ data: { schoolId: schoolB.id, name: 'CE1', level: 'CE1' } });

    const res = await api(adminToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[0]!.id, toClassId: foreign.id, decision: 'promotion' }]));
    expect(res.status).toBe(404);
  });

  it('refuse un élève présent deux fois dans le lot', async () => {
    const res = await api(adminToken).post(`/classes/${classSource.id}/enrollment-decisions`).send(
      batch([
        { studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' },
        { studentId: students[0]!.id, toClassId: classTarget.id, decision: 'redoublement' },
      ]),
    );
    expect(res.status).toBe(400);
    expect(await prisma.enrollmentDecision.count()).toBe(0);
  });

  it("signale un élève d'une autre classe sans échouer", async () => {
    const outsider = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: classTarget.id, firstName: 'Hors', lastName: 'Classe' },
    });

    const res = await api(adminToken).post(`/classes/${classSource.id}/enrollment-decisions`).send(
      batch([
        { studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' },
        { studentId: outsider.id, toClassId: classTarget.id, decision: 'promotion' },
      ]),
    );

    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(1);
    expect(res.body.skipped).toEqual([{ studentId: outsider.id, reason: 'eleve_hors_classe' }]);
  });

  it('ignore un élève archivé', async () => {
    await prisma.student.update({ where: { id: students[0]!.id }, data: { archivedAt: new Date() } });

    const res = await api(adminToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' }]));

    expect(res.body.moved).toBe(0);
    expect(res.body.skipped[0].reason).toBe('eleve_hors_classe');
  });

  it('valide la forme du corps', async () => {
    expect((await api(adminToken).post(`/classes/${classSource.id}/enrollment-decisions`).send({ entries: [] })).status).toBe(400);
    expect(
      (
        await api(adminToken)
          .post(`/classes/${classSource.id}/enrollment-decisions`)
          .send(batch([{ studentId: students[0]!.id, toClassId: classTarget.id, decision: 'saute une classe' as never }]))
      ).status,
    ).toBe(400);
  });
});

describe('GET /classes/:id/enrollment-decisions', () => {
  it("renvoie l'historique, le plus récent d'abord", async () => {
    await api(adminToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[0]!.id, toClassId: classTarget.id, decision: 'promotion' }]));
    await api(adminToken)
      .post(`/classes/${classSource.id}/enrollment-decisions`)
      .send(batch([{ studentId: students[1]!.id, toClassId: classTarget.id, decision: 'redoublement' }]));

    const res = await api(adminToken).get(`/classes/${classSource.id}/enrollment-decisions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].student.id).toBe(students[1]!.id);
    expect(res.body[0].decision).toBe('redoublement');
    expect(res.body[0].toClass).toMatchObject({ id: classTarget.id, name: 'CE1' });
  });

  it('renvoie une liste vide pour une classe sans réinscription', async () => {
    const res = await api(adminToken).get(`/classes/${classSource.id}/enrollment-decisions`);
    expect(res.body).toEqual([]);
  });

  it('refuse un enseignant', async () => {
    const res = await api(teacherToken).get(`/classes/${classSource.id}/enrollment-decisions`);
    expect(res.status).toBe(403);
  });
});
