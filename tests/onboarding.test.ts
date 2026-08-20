import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { resetDatabase } from './helpers';
import { mailer } from '../src/lib/mailer';

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const validBody = {
  schoolName: 'École La Colombe',
  contactName: 'Rosine Adjovi',
  email: 'rosine@lacolombe.test',
  phone: '97000000',
  city: 'Cotonou',
  levels: ['primaire', 'collège'],
};

describe('POST /signup-requests', () => {
  it('enregistre la demande', async () => {
    const res = await request(app).post('/signup-requests').send(validBody);

    expect(res.status).toBe(201);
    const saved = await prisma.signupRequest.findFirstOrThrow({
      where: { schoolName: 'École La Colombe' },
    });
    expect(saved.contactName).toBe('Rosine Adjovi');
    expect(saved.levels).toEqual(['primaire', 'collège']);
  });

  it("prévient l'équipe par email, avec les informations de la demande", async () => {
    const spy = vi.spyOn(mailer, 'send').mockResolvedValue();

    await request(app).post('/signup-requests').send(validBody);

    expect(spy).toHaveBeenCalledOnce();
    const [to, subject, html] = spy.mock.calls[0]!;
    expect(to).toBe('vianneyhoueho@gmail.com');
    expect(subject).toMatch(/École La Colombe/);
    expect(html).toMatch(/Rosine Adjovi/);
    expect(html).toMatch(/Cotonou/);
  });

  it("n'échoue pas si l'envoi de l'email échoue", async () => {
    vi.spyOn(mailer, 'send').mockRejectedValue(new Error('SMTP down'));

    const res = await request(app).post('/signup-requests').send(validBody);

    // Le mailer avale déjà ses erreurs (voir mailer.ts) : ce test protège contre
    // une régression qui ferait remonter l'échec jusqu'à la requête HTTP.
    expect(res.status).toBe(201);
    expect(await prisma.signupRequest.count()).toBe(1);
  });

  it('refuse une demande sans niveau', async () => {
    const res = await request(app)
      .post('/signup-requests')
      .send({ ...validBody, levels: [] });
    expect(res.status).toBe(400);
  });
});
