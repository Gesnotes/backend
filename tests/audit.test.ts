import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase, seedEvaluation, seedGrade } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let autreEcole: { id: number };
let admin: { id: number };
let tokenAdmin: string;
let tokenProf: string;
let tokenParent: string;
let classe6: { id: number };
let classe5: { id: number };
let maths: { id: number };
let term: { id: number };
let devoirId: number;
let ana: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');
  autreEcole = await createSchool('ecole-b');

  admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  const prof = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: school.id, email: 'parent@a.test', role: 'parent' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenProf = signAccessToken({ userId: prof.id, schoolId: school.id, role: 'teacher' });
  tokenParent = signAccessToken({ userId: parent.id, schoolId: school.id, role: 'parent' });

  classe6 = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  classe5 = await prisma.class.create({ data: { schoolId: school.id, name: '5e A', level: '5e' } });
  maths = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });

  const devoir = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2 },
  });
  devoirId = devoir.id;

  await prisma.teacherAssignment.create({
    data: { schoolId: school.id, teacherUserId: prof.id, classId: classe6.id, subjectId: maths.id },
  });

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe6.id, firstName: 'Ana', lastName: 'Alpha' },
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

describe("journal d'audit : note modifiée/supprimée", () => {
  it('trace la modification d’une note, avec l’ancienne et la nouvelle valeur', async () => {
    const grade = await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoirId, termId: term.id, value: 10,
    });

    await api(tokenProf).patch(`/grades/${grade.id}`).send({ value: 15 });

    const logs = await prisma.auditLog.findMany({ where: { schoolId: school.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'grade.updated',
      targetType: 'grade',
      targetId: grade.id,
      targetLabel: 'Ana Alpha',
      actorRole: 'teacher',
    });
    expect(logs[0]!.metadata).toMatchObject({ oldValue: 10, newValue: 15 });
  });

  it('trace la suppression d’une note', async () => {
    const grade = await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoirId, termId: term.id, value: 12,
    });

    await api(tokenProf).delete(`/grades/${grade.id}`);

    const logs = await prisma.auditLog.findMany({ where: { schoolId: school.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'grade.deleted', targetType: 'grade', targetId: grade.id });
  });
});

describe("journal d'audit : élève déplacé de classe", () => {
  it('trace un déplacement de classe, avec la classe de départ et d’arrivée', async () => {
    await api(tokenAdmin).patch(`/students/${ana.id}`).send({ classId: classe5.id });

    const logs = await prisma.auditLog.findMany({ where: { schoolId: school.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'student.moved', targetType: 'student', targetId: ana.id, targetLabel: 'Ana Alpha' });
    expect(logs[0]!.metadata).toMatchObject({ fromClassId: classe6.id, toClassId: classe5.id });
  });

  it("ne trace rien pour une modification qui ne change pas de classe", async () => {
    await api(tokenAdmin).patch(`/students/${ana.id}`).send({ firstName: 'Anna' });

    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("journal d'audit : comptes archivés/restaurés/supprimés", () => {
  it('trace l’archivage et la restauration d’un compte parent', async () => {
    const parent2 = await createUser({ schoolId: school.id, email: 'p2@a.test', role: 'parent' });

    await api(tokenAdmin).delete(`/users/${parent2.id}`);
    await api(tokenAdmin).post(`/users/${parent2.id}/restore`);

    const logs = await prisma.auditLog.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['account.archived', 'account.restored']);
    expect(logs[0]).toMatchObject({ targetType: 'user', targetId: parent2.id, actorRole: 'admin' });
  });

  it('trace l’archivage, la restauration et la suppression définitive d’un compte enseignant', async () => {
    const created = await api(tokenAdmin).post('/teachers').send({
      email: 'prof2@a.test', firstName: 'Jean', lastName: 'Dupont',
    });
    const teacherId = created.body.id as number;

    await api(tokenAdmin).delete(`/teachers/${teacherId}`);
    await api(tokenAdmin).post(`/teachers/${teacherId}/restore`);
    await api(tokenAdmin).delete(`/teachers/${teacherId}`);
    await api(tokenAdmin).delete(`/teachers/${teacherId}?permanent=true&confirm_label=${encodeURIComponent('Jean Dupont')}`);

    const logs = await prisma.auditLog.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual([
      'account.archived', 'account.restored', 'account.archived', 'account.permanently_deleted',
    ]);
    expect(logs.every((l) => l.targetLabel === 'Jean Dupont')).toBe(true);
  });
});

describe('GET /admin/audit-logs', () => {
  it('liste du plus récent au plus ancien', async () => {
    const parent2 = await createUser({ schoolId: school.id, email: 'p2@a.test', role: 'parent' });
    const parent3 = await createUser({ schoolId: school.id, email: 'p3@a.test', role: 'parent' });

    await api(tokenAdmin).delete(`/users/${parent2.id}`);
    await api(tokenAdmin).delete(`/users/${parent3.id}`);

    const res = await api(tokenAdmin).get('/admin/audit-logs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].targetId).toBe(parent3.id);
    expect(res.body[1].targetId).toBe(parent2.id);
  });

  it('respecte la limite demandée', async () => {
    for (let i = 0; i < 3; i += 1) {
      const p = await createUser({ schoolId: school.id, email: `p${i}@a.test`, role: 'parent' });
      await api(tokenAdmin).delete(`/users/${p.id}`);
    }

    const res = await api(tokenAdmin).get('/admin/audit-logs?limit=2');
    expect(res.body).toHaveLength(2);
  });

  it("ne mélange pas les entrées d'une autre école", async () => {
    const foreignAdmin = await createUser({ schoolId: autreEcole.id, email: 'admin@b.test', role: 'admin' });
    const foreignParent = await createUser({ schoolId: autreEcole.id, email: 'p@b.test', role: 'parent' });
    const foreignToken = signAccessToken({ userId: foreignAdmin.id, schoolId: autreEcole.id, role: 'admin' });
    await api(foreignToken).delete(`/users/${foreignParent.id}`);

    const res = await api(tokenAdmin).get('/admin/audit-logs');
    expect(res.body).toHaveLength(0);
  });

  it("est réservé à l'administration", async () => {
    expect((await api(tokenProf).get('/admin/audit-logs')).status).toBe(403);
    expect((await api(tokenParent).get('/admin/audit-logs')).status).toBe(403);
  });
});
