import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let adminToken: string;
let teacherToken: string;
let parentToken: string;

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: school.id, email: 'parent@a.test', role: 'parent' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: school.id, role: 'teacher' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: school.id, role: 'parent' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) =>
    request(app).get(p).set('Authorization', `Bearer ${token}`),
  patch: (p: string) =>
    request(app).patch(p).set('Authorization', `Bearer ${token}`),
  put: (p: string) =>
    request(app).put(p).set('Authorization', `Bearer ${token}`),
  delete: (p: string) =>
    request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

/** PNG 1×1 valide, minimal — suffisant pour tester le décodage sans dépendre d'un vrai logo. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

describe('GET /school', () => {
  it('vaut 10 par défaut', async () => {
    const res = await api(adminToken).get('/school');
    expect(res.status).toBe(200);
    expect(res.body.passingGrade).toBe(10);
  });

  it('est lisible par les trois rôles', async () => {
    expect((await api(teacherToken).get('/school')).status).toBe(200);
    expect((await api(parentToken).get('/school')).status).toBe(200);
  });
});

describe('PATCH /school', () => {
  it("modifie le seuil de passage de l'école", async () => {
    const res = await api(adminToken).patch('/school').send({ passingGrade: 12 });
    expect(res.status).toBe(200);
    expect(res.body.passingGrade).toBe(12);

    const relu = await api(adminToken).get('/school');
    expect(relu.body.passingGrade).toBe(12);
  });

  it('accepte les demi-points', async () => {
    const res = await api(adminToken).patch('/school').send({ passingGrade: 9.5 });
    expect(res.status).toBe(200);
    expect(res.body.passingGrade).toBe(9.5);
  });

  it('refuse une valeur hors barème', async () => {
    expect((await api(adminToken).patch('/school').send({ passingGrade: -1 })).status).toBe(400);
    expect((await api(adminToken).patch('/school').send({ passingGrade: 21 })).status).toBe(400);
  });

  it('refuse à un enseignant ou un parent', async () => {
    expect((await api(teacherToken).patch('/school').send({ passingGrade: 12 })).status).toBe(403);
    expect((await api(parentToken).patch('/school').send({ passingGrade: 12 })).status).toBe(403);
  });

  it("ne change pas le seuil d'une autre école", async () => {
    const autre = await createSchool('ecole-b');
    await api(adminToken).patch('/school').send({ passingGrade: 12 });

    const settings = await prisma.school.findUniqueOrThrow({ where: { id: autre.id } });
    expect(Number(settings.passingGrade)).toBe(10);
  });

  it('modifie les coordonnées (email, téléphone, adresse)', async () => {
    const res = await api(adminToken)
      .patch('/school')
      .send({ email: 'contact@ecole-a.test', phone: '+22961000000', address: 'Cotonou, Bénin' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('contact@ecole-a.test');
    expect(res.body.phone).toBe('+22961000000');
    expect(res.body.address).toBe('Cotonou, Bénin');
  });

  it('efface une coordonnée avec une chaîne vide', async () => {
    await api(adminToken).patch('/school').send({ email: 'contact@ecole-a.test' });
    const res = await api(adminToken).patch('/school').send({ email: '' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBeNull();
  });

  it('refuse un email mal formé', async () => {
    const res = await api(adminToken).patch('/school').send({ email: 'pas-un-email' });
    expect(res.status).toBe(400);
  });

  it('refuse un téléphone mal formé', async () => {
    const res = await api(adminToken).patch('/school').send({ phone: 'abc' });
    expect(res.status).toBe(400);
  });

  it('refuse un corps vide', async () => {
    const res = await api(adminToken).patch('/school').send({});
    expect(res.status).toBe(400);
  });

  it('vaut faux par défaut pour les images de bulletin', async () => {
    const res = await api(adminToken).get('/school');
    expect(res.body.hasBulletinHeaderImage).toBe(false);
    expect(res.body.hasBulletinFooterImage).toBe(false);
  });
});

describe('images du bulletin (en-tête et pied de page)', () => {
  it("téléverse une image d'en-tête, relue ensuite via GET /school", async () => {
    const put = await api(adminToken).put('/school/bulletin-header-image').send({ image: TINY_PNG_DATA_URL });
    expect(put.status).toBe(200);
    expect(put.body.hasBulletinHeaderImage).toBe(true);

    const get = await api(adminToken).get('/school/bulletin-header-image');
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(Buffer.from(get.body).length).toBeGreaterThan(0);
  });

  it("téléverse une image de pied de page indépendamment de l'en-tête", async () => {
    await api(adminToken).put('/school/bulletin-header-image').send({ image: TINY_PNG_DATA_URL });
    const put = await api(adminToken).put('/school/bulletin-footer-image').send({ image: TINY_PNG_DATA_URL });
    expect(put.status).toBe(200);
    expect(put.body.hasBulletinHeaderImage).toBe(true);
    expect(put.body.hasBulletinFooterImage).toBe(true);
  });

  it('renvoie 404 tant que rien n’a été réglé', async () => {
    const res = await api(adminToken).get('/school/bulletin-footer-image');
    expect(res.status).toBe(404);
  });

  it('refuse un format autre que PNG/JPEG', async () => {
    const res = await api(adminToken)
      .put('/school/bulletin-header-image')
      .send({ image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
    expect(res.status).toBe(400);
  });

  it('refuse une image mal formée', async () => {
    const res = await api(adminToken).put('/school/bulletin-header-image').send({ image: 'pas-une-image' });
    expect(res.status).toBe(400);
  });

  it('supprime une image réglée', async () => {
    await api(adminToken).put('/school/bulletin-header-image').send({ image: TINY_PNG_DATA_URL });
    const del = await api(adminToken).delete('/school/bulletin-header-image');
    expect(del.status).toBe(200);
    expect(del.body.hasBulletinHeaderImage).toBe(false);

    expect((await api(adminToken).get('/school/bulletin-header-image')).status).toBe(404);
  });

  it('refuse à un enseignant ou un parent de modifier les images', async () => {
    expect(
      (await api(teacherToken).put('/school/bulletin-header-image').send({ image: TINY_PNG_DATA_URL })).status,
    ).toBe(403);
    expect((await api(parentToken).delete('/school/bulletin-header-image')).status).toBe(403);
  });

  it('lecture ouverte aux trois rôles', async () => {
    await api(adminToken).put('/school/bulletin-header-image').send({ image: TINY_PNG_DATA_URL });
    expect((await api(teacherToken).get('/school/bulletin-header-image')).status).toBe(200);
    expect((await api(parentToken).get('/school/bulletin-header-image')).status).toBe(200);
  });
});
