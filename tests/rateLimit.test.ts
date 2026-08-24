import { describe, expect, it } from 'vitest';

import { credentialsLimiter, staffCredentialsLimiter } from '../src/middlewares/rateLimit';

/**
 * Le budget anti-bruteforce est désactivé en environnement de test (voir
 * `rateLimit.ts`), donc aucun test ici ne peut déclencher un vrai 429 —
 * `npm test` serait alors dépendant de l'ordre des cas. Ce test vérifie
 * directement la propriété qui avait cassé l'isolation des deux mondes
 * d'authentification : `/auth/identify` (comptes école) et `/staff/login`
 * (équipe Gesnotes) doivent chacun compter sur leur propre budget, sinon
 * bombarder l'un épuise aussi l'autre pour la même IP.
 */
describe('isolation des budgets anti-bruteforce', () => {
  it("le limiteur des comptes école n'est pas la même instance que celui de l'équipe", () => {
    expect(credentialsLimiter).not.toBe(staffCredentialsLimiter);
  });
});
