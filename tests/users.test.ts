import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let schoolB: { id: number };
let admin: { id: number };
let adminToken: string;
let teacherToken: string;
let parentToken: string;

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${token}`),
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

describe('GET /users', () => {
  it('liste les 3 comptes de l’école (admin + enseignant + parent)', async () => {
    const res = await api(adminToken).get('/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((u: { role: string }) => u.role).sort()).toEqual(['admin', 'parent', 'teacher']);
  });

  it('filtre par rôle', async () => {
    const res = await api(adminToken).get('/users?role=parent');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].role).toBe('parent');
  });

  it('exclut les comptes archivés par défaut, les inclut avec include_archived', async () => {
    const other = await createUser({ schoolId: schoolA.id, email: 'autre@a.test', role: 'parent' });
    await prisma.user.update({ where: { id: other.id }, data: { archivedAt: new Date() } });

    expect((await api(adminToken).get('/users?role=parent')).body).toHaveLength(1);
    expect((await api(adminToken).get('/users?role=parent&include_archived=true')).body).toHaveLength(2);
  });

  it("ne mélange pas les comptes d'une autre école", async () => {
    await createUser({ schoolId: schoolB.id, email: 'admin@b.test', role: 'admin' });
    const res = await api(adminToken).get('/users');
    expect(res.body).toHaveLength(3);
  });

  it('refuse un enseignant ou un parent', async () => {
    expect((await api(teacherToken).get('/users')).status).toBe(403);
    expect((await api(parentToken).get('/users')).status).toBe(403);
  });
});

describe('DELETE /users/:id (archivage)', () => {
  it('archive un compte parent', async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'p2@a.test', role: 'parent' });
    const res = await api(adminToken).delete(`/users/${parent.id}`);
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).not.toBeNull();

    const reread = await prisma.user.findUniqueOrThrow({ where: { id: parent.id } });
    expect(reread.archivedAt).not.toBeNull();
  });

  it('révoque les sessions actives du compte archivé', async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'p3@a.test', role: 'parent' });
    await prisma.refreshToken.create({
      data: { userId: parent.id, tokenHash: 'x', expiresAt: new Date(Date.now() + 1000 * 60 * 60) },
    });

    await api(adminToken).delete(`/users/${parent.id}`);

    const token = await prisma.refreshToken.findFirstOrThrow({ where: { userId: parent.id } });
    expect(token.revokedAt).not.toBeNull();
  });

  it('refuse d’archiver un compte enseignant (renvoie vers /teachers)', async () => {
    const teacher = await createUser({ schoolId: schoolA.id, email: 't2@a.test', role: 'teacher' });
    const res = await api(adminToken).delete(`/users/${teacher.id}`);
    expect(res.status).toBe(400);
  });

  it('refuse à un admin d’archiver son propre compte', async () => {
    const res = await api(adminToken).delete(`/users/${admin.id}`);
    expect(res.status).toBe(400);
  });

  it("refuse un compte d'une autre école", async () => {
    const foreign = await createUser({ schoolId: schoolB.id, email: 'p@b.test', role: 'parent' });
    const res = await api(adminToken).delete(`/users/${foreign.id}`);
    expect(res.status).toBe(404);
  });

  it('refuse à un enseignant ou un parent', async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'p4@a.test', role: 'parent' });
    expect((await api(teacherToken).delete(`/users/${parent.id}`)).status).toBe(403);
    expect((await api(parentToken).delete(`/users/${parent.id}`)).status).toBe(403);
  });
});

describe('POST /users/:id/restore', () => {
  it('restaure un compte parent archivé', async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'p5@a.test', role: 'parent' });
    await api(adminToken).delete(`/users/${parent.id}`);

    const res = await api(adminToken).post(`/users/${parent.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).toBeNull();
  });

  it('refuse de restaurer un compte enseignant (renvoie vers /teachers)', async () => {
    const teacher = await createUser({ schoolId: schoolA.id, email: 't3@a.test', role: 'teacher' });
    const res = await api(adminToken).post(`/users/${teacher.id}/restore`);
    expect(res.status).toBe(400);
  });
});
