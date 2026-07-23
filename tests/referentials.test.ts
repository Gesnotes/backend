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

/** Date du jour au format `YYYY-MM-DD`, décalée de `days` jours. */
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

describe('GET /terms', () => {
  it('liste les périodes de l’école, de la plus ancienne à la plus récente', async () => {
    // Créées dans le désordre : l'ordre de la réponse doit venir des dates.
    await prisma.term.createMany({
      data: [
        { schoolId: schoolA.id, label: 'Trimestre 2', startDate: new Date('2026-01-05'), endDate: new Date('2026-03-31') },
        { schoolId: schoolA.id, label: 'Trimestre 1', startDate: new Date('2025-09-15'), endDate: new Date('2025-12-20') },
      ],
    });

    const res = await api(adminToken).get('/terms');

    expect(res.status).toBe(200);
    expect(res.body.map((t: { label: string }) => t.label)).toEqual(['Trimestre 1', 'Trimestre 2']);
    expect(res.body[0]).toMatchObject({ startDate: '2025-09-15', endDate: '2025-12-20' });
  });

  it('marque comme en cours la seule période qui contient la date du jour', async () => {
    await prisma.term.createMany({
      data: [
        { schoolId: schoolA.id, label: 'Passée', startDate: new Date(day(-60)), endDate: new Date(day(-30)) },
        { schoolId: schoolA.id, label: 'En cours', startDate: new Date(day(-10)), endDate: new Date(day(10)) },
        { schoolId: schoolA.id, label: 'À venir', startDate: new Date(day(30)), endDate: new Date(day(60)) },
      ],
    });

    const res = await api(adminToken).get('/terms');
    const current = res.body.filter((t: { isCurrent: boolean }) => t.isCurrent);

    expect(current).toHaveLength(1);
    expect(current[0].label).toBe('En cours');
  });

  /**
   * Le dernier jour d'un trimestre est celui des compositions : une
   * comparaison d'instants l'exclurait, `start_date`/`end_date` étant remontées
   * à minuit UTC par Prisma.
   */
  it('inclut le premier et le dernier jour de la période', async () => {
    await prisma.term.create({
      data: {
        schoolId: schoolA.id,
        label: 'Se termine aujourd’hui',
        startDate: new Date(day(-30)),
        endDate: new Date(day(0)),
      },
    });

    const res = await api(adminToken).get('/terms');
    expect(res.body[0].isCurrent).toBe(true);
  });

  it('renvoie les périodes sans dates en fin de liste, jamais en cours', async () => {
    await prisma.term.createMany({
      data: [
        { schoolId: schoolA.id, label: 'Sans dates' },
        { schoolId: schoolA.id, label: 'Datée', startDate: new Date(day(-5)), endDate: new Date(day(5)) },
      ],
    });

    const res = await api(adminToken).get('/terms');

    expect(res.body.map((t: { label: string }) => t.label)).toEqual(['Datée', 'Sans dates']);
    expect(res.body[1]).toMatchObject({ startDate: null, endDate: null, isCurrent: false });
  });

  it('est ouvert aux trois rôles : le parent en a besoin pour choisir sa période', async () => {
    await prisma.term.create({ data: { schoolId: schoolA.id, label: 'Trimestre 1' } });

    for (const token of [adminToken, teacherToken, parentToken]) {
      const res = await api(token).get('/terms');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    }
  });

  it('refuse une requête sans token', async () => {
    const res = await request(app).get('/terms').set('X-School-Subdomain', 'ecole-a');
    expect(res.status).toBe(401);
  });

  it('ne laisse jamais fuir les périodes d’une autre école', async () => {
    await prisma.term.create({ data: { schoolId: schoolA.id, label: 'Trimestre 1' } });

    const res = await api(adminBToken, 'ecole-b').get('/terms');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /terms/:id', () => {
  it('renvoie 404 pour une période d’une autre école', async () => {
    const term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'Trimestre 1' } });

    expect((await api(adminToken).get(`/terms/${term.id}`)).status).toBe(200);
    expect((await api(adminBToken, 'ecole-b').get(`/terms/${term.id}`)).status).toBe(404);
  });

  it('valide le paramètre', async () => {
    expect((await api(adminToken).get('/terms/abc')).status).toBe(400);
  });
});

describe('GET /grade-types', () => {
  it('liste les catégories par position, poids sérialisé en nombre', async () => {
    await prisma.gradeType.createMany({
      data: [
        { schoolId: schoolA.id, code: 'composition', label: 'Composition', weight: 3, position: 3 },
        { schoolId: schoolA.id, code: 'interrogation', label: 'Interrogation', weight: 1, position: 1 },
        { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
      ],
    });

    const res = await api(teacherToken).get('/grade-types');

    expect(res.status).toBe(200);
    expect(res.body.map((t: { code: string }) => t.code)).toEqual([
      'interrogation',
      'devoir',
      'composition',
    ]);
    // Un Decimal Prisma sérialisé tel quel partirait en chaîne.
    expect(res.body.every((t: { weight: unknown }) => typeof t.weight === 'number')).toBe(true);
    expect(res.body[2].weight).toBe(3);
  });

  it('reste réservé à l’équipe pédagogique', async () => {
    expect((await api(parentToken).get('/grade-types')).status).toBe(403);
  });

  it('refuse une requête sans token', async () => {
    const res = await request(app).get('/grade-types').set('X-School-Subdomain', 'ecole-a');
    expect(res.status).toBe(401);
  });

  it('ne laisse jamais fuir les catégories d’une autre école', async () => {
    await prisma.gradeType.create({
      data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2, position: 1 },
    });

    const res = await api(adminBToken, 'ecole-b').get('/grade-types');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
