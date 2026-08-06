import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { resetDatabase } from './helpers';

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('GET /schools/search', () => {
  it("trouve une école par nom, sans en-tête ni authentification", async () => {
    await prisma.school.create({
      data: { name: 'École La Colombe', subdomain: 'la-colombe', city: 'Cotonou' },
    });

    const res = await request(app).get('/schools/search?q=Colombe');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: 'École La Colombe',
      subdomain: 'la-colombe',
      city: 'Cotonou',
    });
  });

  it('trouve une école par ville', async () => {
    await prisma.school.create({
      data: { name: 'Collège Saint-Michel', subdomain: 'saint-michel', city: 'Porto-Novo' },
    });

    const res = await request(app).get('/schools/search?q=Porto');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Collège Saint-Michel');
  });

  it('ignore la casse et les accents partiellement (contains insensible à la casse)', async () => {
    await prisma.school.create({
      data: { name: 'École La Colombe', subdomain: 'la-colombe', city: 'Cotonou' },
    });

    const res = await request(app).get('/schools/search?q=colombe');
    expect(res.body).toHaveLength(1);
  });

  it("ne renvoie que les champs publics, jamais d'information sensible", async () => {
    await prisma.school.create({
      data: { name: 'École La Colombe', subdomain: 'la-colombe', city: 'Cotonou' },
    });

    const res = await request(app).get('/schools/search?q=Colombe');
    expect(Object.keys(res.body[0]).sort()).toEqual(['city', 'id', 'name', 'subdomain']);
  });

  it('exige au moins deux caractères', async () => {
    const res = await request(app).get('/schools/search?q=a');
    expect(res.status).toBe(400);
  });

  it('ne renvoie rien sans correspondance', async () => {
    const res = await request(app).get('/schools/search?q=Introuvable');
    expect(res.body).toEqual([]);
  });
});

describe('POST /signup-requests', () => {
  const body = {
    schoolName: 'École La Colombe',
    contactName: 'Rosine Adjovi',
    phone: '97000000',
    city: 'Cotonou',
    levels: ['garderie', 'maternelle'],
  };

  it('enregistre une demande valide, sans en-tête ni authentification', async () => {
    const res = await request(app).post('/signup-requests').send(body);

    expect(res.status).toBe(201);
    expect(await prisma.signupRequest.count()).toBe(1);

    const saved = await prisma.signupRequest.findFirstOrThrow();
    expect(saved).toMatchObject({
      schoolName: 'École La Colombe',
      contactName: 'Rosine Adjovi',
      city: 'Cotonou',
      levels: ['garderie', 'maternelle'],
      status: 'nouveau',
    });
  });

  it("exige le nom de l'école", async () => {
    const res = await request(app).post('/signup-requests').send({ ...body, schoolName: '' });
    expect(res.status).toBe(400);
    expect(await prisma.signupRequest.count()).toBe(0);
  });

  it('exige un téléphone valide', async () => {
    const res = await request(app).post('/signup-requests').send({ ...body, phone: 'pas un numero' });
    expect(res.status).toBe(400);
  });

  it('exige au moins un niveau', async () => {
    const res = await request(app).post('/signup-requests').send({ ...body, levels: [] });
    expect(res.status).toBe(400);
  });

  it("ne crée ni école ni compte : la configuration reste manuelle", async () => {
    await request(app).post('/signup-requests').send(body);

    expect(await prisma.school.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });
});
