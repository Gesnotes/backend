import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase, seedGrade } from './helpers';
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

describe('Écriture des périodes', () => {
  const term = { label: 'Trimestre 1', startDate: '2025-09-01', endDate: '2025-12-20' };

  const write = (token: string, subdomain = 'ecole-a') => ({
    post: (p: string) =>
      request(app).post(p).set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`),
    patch: (p: string) =>
      request(app).patch(p).set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`),
    delete: (p: string) =>
      request(app).delete(p).set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`),
  });

  it('crée une période et la renvoie au format de lecture', async () => {
    const res = await write(adminToken).post('/terms').send(term);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      label: 'Trimestre 1',
      startDate: '2025-09-01',
      endDate: '2025-12-20',
      isCurrent: false,
    });
  });

  /**
   * Une seule borne rendrait `isCurrent` incalculable : la période
   * n'apparaîtrait jamais comme en cours, sans que rien ne l'explique.
   */
  it('refuse une période bornée d’un seul côté', async () => {
    const res = await write(adminToken).post('/terms').send({
      label: 'Bancale',
      startDate: '2025-09-01',
    });
    expect(res.status).toBe(400);
  });

  it('refuse une date de fin antérieure au début', async () => {
    const res = await write(adminToken).post('/terms').send({
      label: 'Inversée',
      startDate: '2025-12-20',
      endDate: '2025-09-01',
    });
    expect(res.status).toBe(400);
  });

  it('refuse deux périodes qui se chevauchent', async () => {
    await write(adminToken).post('/terms').send(term);

    const res = await write(adminToken).post('/terms').send({
      label: 'Chevauche',
      startDate: '2025-12-01',
      endDate: '2026-02-01',
    });

    expect(res.status).toBe(409);
  });

  it('autorise deux périodes contiguës mais disjointes', async () => {
    await write(adminToken).post('/terms').send(term);

    const res = await write(adminToken).post('/terms').send({
      label: 'Trimestre 2',
      startDate: '2025-12-21',
      endDate: '2026-03-31',
    });

    expect(res.status).toBe(201);
  });

  it('laisse une autre école utiliser les mêmes dates', async () => {
    await write(adminToken).post('/terms').send(term);

    const res = await write(adminBToken, 'ecole-b').post('/terms').send(term);
    expect(res.status).toBe(201);
  });

  it('valide les bornes en tenant compte des dates déjà en base', async () => {
    const created = await write(adminToken).post('/terms').send(term);

    // Seule la date de fin change : le contrôle doit voir la date de début
    // stockée, sinon la période devient incohérente sans erreur.
    const res = await write(adminToken)
      .patch(`/terms/${created.body.id}`)
      .send({ endDate: '2025-08-01' });

    expect(res.status).toBe(400);
  });

  it('renomme une période sans toucher aux dates', async () => {
    const created = await write(adminToken).post('/terms').send(term);

    const res = await write(adminToken)
      .patch(`/terms/${created.body.id}`)
      .send({ label: 'Premier trimestre' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ label: 'Premier trimestre', startDate: '2025-09-01' });
  });

  it('supprime une période vide', async () => {
    const created = await write(adminToken).post('/terms').send(term);
    expect((await write(adminToken).delete(`/terms/${created.body.id}`)).status).toBe(204);
  });

  /**
   * Il n'y a pas d'archivage sur Term : la cascade emporterait les notes de
   * tout un trimestre, soit le travail de saisie d'une équipe entière.
   */
  it('refuse de supprimer une période portant des notes', async () => {
    const created = await write(adminToken).post('/terms').send(term);

    const klass = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '6e A', level: '6e' },
    });
    const subject = await prisma.subject.create({
      data: { schoolId: schoolA.id, name: 'Maths', coefficient: 2 },
    });
    const gradeType = await prisma.gradeType.create({
      data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2, position: 1 },
    });
    const student = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: klass.id, firstName: 'Adjovi', lastName: 'Sagbo' },
    });
    await seedGrade({
      schoolId: schoolA.id,
      studentId: student.id,
      subjectId: subject.id,
      gradeTypeId: gradeType.id,
      termId: created.body.id,
      value: 15,
      maxValue: 20,
    });

    const res = await write(adminToken).delete(`/terms/${created.body.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error.details.gradeCount).toBe(1);
  });

  it('réserve l’écriture à l’administration', async () => {
    expect((await write(teacherToken).post('/terms').send(term)).status).toBe(403);
    expect((await write(parentToken).post('/terms').send(term)).status).toBe(403);
  });

  it('ne laisse pas modifier la période d’une autre école', async () => {
    const created = await write(adminToken).post('/terms').send(term);

    const res = await write(adminBToken, 'ecole-b')
      .patch(`/terms/${created.body.id}`)
      .send({ label: 'Pirate' });

    expect(res.status).toBe(404);
  });
});
