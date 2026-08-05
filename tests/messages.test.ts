import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

/**
 * Les messages rendus à l'utilisateur.
 *
 * Gesnotes s'adresse à des secrétariats et à des familles, pas à des
 * développeurs : un message en anglais, ou truffé de vocabulaire technique, est
 * un message qui ne sera pas suivi d'effet. Ces tests verrouillent ce qui a
 * déjà dérivé une fois.
 */
const app = createApp();

let school: { id: number };
let adminToken: string;

beforeEach(async () => {
  await resetDatabase();
  school = await createSchool('ecole-a');
  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  adminToken = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) =>
    request(app).get(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  post: (p: string) =>
    request(app).post(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
});

/**
 * Mots qui trahissent un message écrit pour un développeur.
 *
 * Testés sur des limites de mot, et non en simple inclusion : « invalid »
 * apparaît dans le parfaitement français « invalide », et le test se serait
 * mis à échouer sur des messages corrects.
 */
const JARGON = [
  /\btoken\b/,
  /\bsous-domaine\b/,
  /\ben-tête\b/,
  /\bpayload\b/,
  /\binvalid\b/,
  /\bexpected\b/,
  /\brequired\b/,
  /\bmust be\b/,
  /\brôle insuffisant\b/,
];

function assertPlainFrench(message: string) {
  for (const pattern of JARGON) {
    expect(message.toLowerCase(), `${pattern} ne doit pas apparaître : ${message}`).not.toMatch(
      pattern,
    );
  }
}

describe('messages de validation', () => {
  /**
   * Zod répond en anglais par défaut. Sans la locale française, l'utilisateur
   * lisait « Invalid email address » ou « Too small: expected string… ».
   */
  it('sont en français, pas dans l’anglais par défaut de Zod', async () => {
    const res = await api(adminToken).post('/teachers').send({ email: 'pas-un-email' });

    expect(res.status).toBe(400);
    assertPlainFrench(res.body.error.message);
  });

  /**
   * Les clés de l'API sont techniques (`classId`, `maxValue`) : telles quelles
   * dans un message, elles n'apprennent rien sur le champ fautif du formulaire.
   */
  it('nomment le champ en clair, pas par sa clé technique', async () => {
    const res = await api(adminToken)
      .post('/students')
      .send({ firstName: 'Ana', lastName: 'Alpha' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Classe');
    expect(res.body.error.message).not.toContain('classId');
  });
});

describe('messages d’authentification', () => {
  it('disent quoi vérifier quand la connexion échoue', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('X-School-Subdomain', 'ecole-a')
      .send({ identifier: 'admin@a.test', password: 'mauvais' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/mot de passe/i);
    assertPlainFrench(res.body.error.message);
  });

  it('expliquent une session expirée sans parler de jeton', async () => {
    const res = await request(app)
      .get('/me')
      .set('X-School-Subdomain', 'ecole-a')
      .set('Authorization', 'Bearer nimportequoi');

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/reconnectez-vous/i);
    assertPlainFrench(res.body.error.message);
  });
});

describe('messages d’autorisation', () => {
  it('disent que l’accès est refusé, pas que le « rôle est insuffisant »', async () => {
    const parent = await createUser({ schoolId: school.id, email: 'p@a.test', role: 'parent' });
    const parentToken = signAccessToken({
      userId: parent.id,
      schoolId: school.id,
      role: 'parent',
    });

    const res = await api(parentToken).get('/teachers');

    expect(res.status).toBe(403);
    assertPlainFrench(res.body.error.message);
  });
});

describe('adresse inconnue', () => {
  it('répond en français courant', async () => {
    const res = await api(adminToken).get('/cette-route-nexiste-pas');

    expect(res.status).toBe(404);
    assertPlainFrench(res.body.error.message);
  });
});
