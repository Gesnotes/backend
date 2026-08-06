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
let adminBToken: string;

function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });
  const adminB = await createUser({ schoolId: schoolB.id, email: 'admin@b.test', role: 'admin' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });
  adminBToken = signAccessToken({ userId: adminB.id, schoolId: schoolB.id, role: 'admin' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string, subdomain = 'ecole-a') => ({
  get: (p: string) =>
    request(app).get(p).set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`),
});

const write = (token: string, subdomain = 'ecole-a') => ({
  post: (p: string) =>
    request(app).post(p).set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`),
  patch: (p: string) =>
    request(app).patch(p).set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`),
  delete: (p: string) =>
    request(app).delete(p).set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`),
});

describe('GET /school-years', () => {
  it('liste les années de l’école, de la plus ancienne à la plus récente', async () => {
    await prisma.schoolYear.createMany({
      data: [
        { schoolId: schoolA.id, label: '2026-2027', startDate: new Date('2026-09-01'), endDate: new Date('2027-07-15') },
        { schoolId: schoolA.id, label: '2025-2026', startDate: new Date('2025-09-01'), endDate: new Date('2026-07-15') },
      ],
    });

    const res = await api(adminToken).get('/school-years');

    expect(res.status).toBe(200);
    expect(res.body.map((y: { label: string }) => y.label)).toEqual(['2025-2026', '2026-2027']);
  });

  it('marque comme en cours la seule année qui contient la date du jour', async () => {
    await prisma.schoolYear.createMany({
      data: [
        { schoolId: schoolA.id, label: 'Passée', startDate: new Date(day(-400)), endDate: new Date(day(-300)) },
        { schoolId: schoolA.id, label: 'En cours', startDate: new Date(day(-30)), endDate: new Date(day(300)) },
      ],
    });

    const res = await api(adminToken).get('/school-years');
    const current = res.body.filter((y: { isCurrent: boolean }) => y.isCurrent);

    expect(current).toHaveLength(1);
    expect(current[0].label).toBe('En cours');
  });

  it('renvoie les années sans dates en fin de liste, jamais en cours', async () => {
    await prisma.schoolYear.createMany({
      data: [
        { schoolId: schoolA.id, label: 'Sans dates' },
        { schoolId: schoolA.id, label: 'Datée', startDate: new Date(day(-5)), endDate: new Date(day(5)) },
      ],
    });

    const res = await api(adminToken).get('/school-years');

    expect(res.body.map((y: { label: string }) => y.label)).toEqual(['Datée', 'Sans dates']);
    expect(res.body[1]).toMatchObject({ startDate: null, endDate: null, isCurrent: false });
  });

  it('est ouvert aux trois rôles', async () => {
    await prisma.schoolYear.create({ data: { schoolId: schoolA.id, label: '2025-2026' } });

    for (const token of [adminToken, teacherToken, parentToken]) {
      const res = await api(token).get('/school-years');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    }
  });

  it('refuse une requête sans token', async () => {
    const res = await request(app).get('/school-years').set('X-School-Subdomain', 'ecole-a');
    expect(res.status).toBe(401);
  });

  it('ne laisse jamais fuir les années d’une autre école', async () => {
    await prisma.schoolYear.create({ data: { schoolId: schoolA.id, label: '2025-2026' } });

    const res = await api(adminBToken, 'ecole-b').get('/school-years');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('exclut les années archivées par défaut, les inclut avec include_archived', async () => {
    const year = await prisma.schoolYear.create({ data: { schoolId: schoolA.id, label: '2024-2025' } });
    await write(adminToken).delete(`/school-years/${year.id}`);

    expect((await api(adminToken).get('/school-years')).body).toEqual([]);
    expect((await api(adminToken).get('/school-years?include_archived=true')).body).toHaveLength(1);
  });
});

describe('Écriture des années scolaires', () => {
  const year = { label: '2025-2026', startDate: '2025-09-01', endDate: '2026-07-15' };

  it('crée une année et la renvoie au format de lecture', async () => {
    const res = await write(adminToken).post('/school-years').send(year);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ label: '2025-2026', termCount: 0 });
  });

  it('refuse une année bornée d’un seul côté', async () => {
    const res = await write(adminToken).post('/school-years').send({ label: 'Bancale', startDate: '2025-09-01' });
    expect(res.status).toBe(400);
  });

  it('refuse deux années qui se chevauchent', async () => {
    await write(adminToken).post('/school-years').send(year);

    const res = await write(adminToken).post('/school-years').send({
      label: 'Chevauche',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });

    expect(res.status).toBe(409);
  });

  it('autorise deux années contiguës mais disjointes', async () => {
    await write(adminToken).post('/school-years').send(year);

    const res = await write(adminToken).post('/school-years').send({
      label: '2026-2027',
      startDate: '2026-09-01',
      endDate: '2027-07-15',
    });

    expect(res.status).toBe(201);
  });

  it('réserve l’écriture à l’administration', async () => {
    expect((await write(teacherToken).post('/school-years').send(year)).status).toBe(403);
    expect((await write(parentToken).post('/school-years').send(year)).status).toBe(403);
  });

  it('ne laisse pas modifier l’année d’une autre école', async () => {
    const created = await write(adminToken).post('/school-years').send(year);

    const res = await write(adminBToken, 'ecole-b')
      .patch(`/school-years/${created.body.id}`)
      .send({ label: 'Pirate' });

    expect(res.status).toBe(404);
  });
});

describe('Archivage et suppression définitive d’une année scolaire', () => {
  const year = { label: '2025-2026', startDate: '2025-09-01', endDate: '2026-07-15' };

  it('archive une année sans toucher aux périodes rattachées', async () => {
    const created = await write(adminToken).post('/school-years').send(year);
    const term = await prisma.term.create({
      data: { schoolId: schoolA.id, schoolYearId: created.body.id, label: 'Trimestre 1' },
    });

    expect((await write(adminToken).delete(`/school-years/${created.body.id}`)).status).toBe(204);

    const archived = (await api(adminToken).get('/school-years?include_archived=true')).body[0];
    expect(archived.archivedAt).not.toBeNull();
    // La période n'est ni archivée ni détachée par l'archivage de l'année.
    const stillLinked = await prisma.term.findUnique({ where: { id: term.id } });
    expect(stillLinked?.schoolYearId).toBe(created.body.id);
    expect(stillLinked?.archivedAt).toBeNull();
  });

  it('restaure une année archivée', async () => {
    const created = await write(adminToken).post('/school-years').send(year);
    await write(adminToken).delete(`/school-years/${created.body.id}`);

    const res = await write(adminToken).post(`/school-years/${created.body.id}/restore`).send({});

    expect(res.status).toBe(200);
    expect(res.body.archivedAt).toBeNull();
  });

  it('exige l’archivage avant la suppression définitive', async () => {
    const created = await write(adminToken).post('/school-years').send(year);

    const res = await write(adminToken).delete(
      `/school-years/${created.body.id}?permanent=true&confirm_label=${encodeURIComponent(year.label)}`,
    );

    expect(res.status).toBe(409);
  });

  it('exige le libellé exact pour la suppression définitive', async () => {
    const created = await write(adminToken).post('/school-years').send(year);
    await write(adminToken).delete(`/school-years/${created.body.id}`);

    const res = await write(adminToken).delete(
      `/school-years/${created.body.id}?permanent=true&confirm_label=Autre`,
    );

    expect(res.status).toBe(400);
    expect(await prisma.schoolYear.count({ where: { id: created.body.id } })).toBe(1);
  });

  /**
   * Contrairement à une période, une année n'emporte pas ses dépendances :
   * les trimestres ont leur propre cycle de vie (et leurs propres notes). La
   * suppression définitive les détache plutôt que de les détruire.
   */
  it('détache les périodes plutôt que de les détruire à la suppression définitive', async () => {
    const created = await write(adminToken).post('/school-years').send(year);
    const term = await prisma.term.create({
      data: { schoolId: schoolA.id, schoolYearId: created.body.id, label: 'Trimestre 1' },
    });
    await write(adminToken).delete(`/school-years/${created.body.id}`);

    const res = await write(adminToken).delete(
      `/school-years/${created.body.id}?permanent=true&confirm_label=${encodeURIComponent(year.label)}`,
    );

    expect(res.status).toBe(204);
    expect(await prisma.schoolYear.count({ where: { id: created.body.id } })).toBe(0);
    const survivor = await prisma.term.findUnique({ where: { id: term.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.schoolYearId).toBeNull();
  });

  it('détache aussi les classes plutôt que de les détruire à la suppression définitive', async () => {
    const created = await write(adminToken).post('/school-years').send(year);
    const klass = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '6e A', level: '6e', schoolYearId: created.body.id },
    });
    await write(adminToken).delete(`/school-years/${created.body.id}`);

    const res = await write(adminToken).delete(
      `/school-years/${created.body.id}?permanent=true&confirm_label=${encodeURIComponent(year.label)}`,
    );

    expect(res.status).toBe(204);
    const survivor = await prisma.class.findUnique({ where: { id: klass.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.schoolYearId).toBeNull();
  });

  it('réserve l’archivage et la restauration à l’administration', async () => {
    const created = await write(adminToken).post('/school-years').send(year);

    expect((await write(teacherToken).delete(`/school-years/${created.body.id}`)).status).toBe(403);
    expect(
      (await write(parentToken).post(`/school-years/${created.body.id}/restore`).send({})).status,
    ).toBe(403);
  });
});
