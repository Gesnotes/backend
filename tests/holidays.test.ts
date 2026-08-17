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

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string, body: object = {}) => request(app).post(p).set('Authorization', `Bearer ${token}`).send(body),
  patch: (p: string, body: object) => request(app).patch(p).set('Authorization', `Bearer ${token}`).send(body),
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

const createHoliday = (date: string, label: string) =>
  prisma.holiday.create({ data: { schoolId: schoolA.id, date: new Date(date), label } });

describe('GET /holidays', () => {
  it('liste les jours fériés, triés par date', async () => {
    await createHoliday('2026-05-01', 'Fête du travail');
    await createHoliday('2026-01-10', 'Fête du Vodoun');

    const res = await api(adminToken).get('/holidays');
    expect(res.status).toBe(200);
    expect(res.body.map((h: { label: string }) => h.label)).toEqual(['Fête du Vodoun', 'Fête du travail']);
  });

  it('exclut les jours archivés par défaut, les inclut avec include_archived', async () => {
    const holiday = await createHoliday('2026-05-01', 'Fête du travail');
    await prisma.holiday.update({ where: { id: holiday.id }, data: { archivedAt: new Date() } });

    expect((await api(adminToken).get('/holidays')).body).toHaveLength(0);
    expect((await api(adminToken).get('/holidays?include_archived=true')).body).toHaveLength(1);
  });

  it("ne mélange pas les jours d'une autre école", async () => {
    await prisma.holiday.create({ data: { schoolId: schoolB.id, date: new Date('2026-05-01'), label: 'Autre école' } });

    const res = await api(adminToken).get('/holidays');
    expect(res.body).toHaveLength(0);
  });

  it('refuse un enseignant', async () => {
    expect((await api(teacherToken).get('/holidays')).status).toBe(403);
  });
});

describe('POST /holidays', () => {
  it('crée un jour férié', async () => {
    const res = await api(adminToken).post('/holidays', { date: '2026-01-10', label: 'Fête du Vodoun' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ date: '2026-01-10', label: 'Fête du Vodoun', archivedAt: null });
  });

  it('refuse un doublon actif à la même date', async () => {
    await createHoliday('2026-01-10', 'Fête du Vodoun');
    const res = await api(adminToken).post('/holidays', { date: '2026-01-10', label: 'Doublon' });
    expect(res.status).toBe(409);
  });

  it('autorise un jour à la même date qu’un jour archivé', async () => {
    const first = await createHoliday('2026-01-10', 'Ancien');
    await prisma.holiday.update({ where: { id: first.id }, data: { archivedAt: new Date() } });

    const res = await api(adminToken).post('/holidays', { date: '2026-01-10', label: 'Nouveau' });
    expect(res.status).toBe(201);
  });

  it('refuse une date manquante', async () => {
    expect((await api(adminToken).post('/holidays', { label: 'Sans date' })).status).toBe(400);
  });
});

describe('PATCH /holidays/:id', () => {
  it('modifie le libellé', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    const res = await api(adminToken).patch(`/holidays/${holiday.id}`, { label: 'Vodoun (corrigé)' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Vodoun (corrigé)');
  });

  it('refuse de déplacer sur une date déjà prise', async () => {
    await createHoliday('2026-01-10', 'Fête du Vodoun');
    const other = await createHoliday('2026-05-01', 'Fête du travail');

    const res = await api(adminToken).patch(`/holidays/${other.id}`, { date: '2026-01-10' });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /holidays/:id (archivage)', () => {
  it('archive un jour férié', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    const res = await api(adminToken).delete(`/holidays/${holiday.id}`);
    expect(res.status).toBe(204);

    const reread = await prisma.holiday.findUniqueOrThrow({ where: { id: holiday.id } });
    expect(reread.archivedAt).not.toBeNull();
  });

  it('supprime définitivement un jour archivé avec le bon libellé', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    await api(adminToken).delete(`/holidays/${holiday.id}`);

    const res = await api(adminToken).delete(
      `/holidays/${holiday.id}?permanent=true&confirm_label=${encodeURIComponent('Fête du Vodoun')}`,
    );
    expect(res.status).toBe(204);
    expect(await prisma.holiday.findUnique({ where: { id: holiday.id } })).toBeNull();
  });

  it('refuse la suppression définitive sans archivage préalable', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    const res = await api(adminToken).delete(
      `/holidays/${holiday.id}?permanent=true&confirm_label=${encodeURIComponent('Fête du Vodoun')}`,
    );
    expect(res.status).toBe(409);
  });

  it('refuse la suppression définitive si le libellé ne correspond pas', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    await api(adminToken).delete(`/holidays/${holiday.id}`);

    const res = await api(adminToken).delete(`/holidays/${holiday.id}?permanent=true&confirm_label=Faux`);
    expect(res.status).toBe(400);
  });

  it('refuse un enseignant', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    expect((await api(teacherToken).delete(`/holidays/${holiday.id}`)).status).toBe(403);
  });
});

describe('POST /holidays/:id/restore', () => {
  it('restaure un jour férié archivé', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    await api(adminToken).delete(`/holidays/${holiday.id}`);

    const res = await api(adminToken).post(`/holidays/${holiday.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).toBeNull();
  });

  it('refuse de restaurer sur une date déjà reprise par un autre jour actif', async () => {
    const holiday = await createHoliday('2026-01-10', 'Fête du Vodoun');
    await api(adminToken).delete(`/holidays/${holiday.id}`);
    await createHoliday('2026-01-10', 'Nouveau jour');

    const res = await api(adminToken).post(`/holidays/${holiday.id}/restore`);
    expect(res.status).toBe(409);
  });
});
