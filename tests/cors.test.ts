import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

const app = createApp();

/**
 * CORS n'est appliqué par le navigateur qu'aux requêtes réellement
 * cross-origin ; supertest n'envoie jamais d'en-tête `Origin` par défaut,
 * donc ces tests le fixent explicitement pour vérifier la liste blanche.
 */
describe('CORS', () => {
  it("autorise l'origine locale de développement (WEB_APP_URL)", async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it("refuse une origine inconnue, sans bloquer la requête côté serveur", async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Le blocage est du ressort du navigateur (absence de l'en-tête) : le
    // serveur, lui, répond normalement — un appel serveur-à-serveur légitime
    // n'a jamais d'en-tête Origin de toute façon.
    expect(res.status).toBe(200);
  });

  it("autorise une requête sans en-tête Origin (appel serveur-à-serveur)", async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
