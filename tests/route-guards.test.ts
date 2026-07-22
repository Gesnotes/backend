import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

/**
 * Garde-fou structurel.
 *
 * Trois fuites de données ont eu la même cause : un routeur montait
 * `requireAuth` en global et ne déclarait `requireRole` que sur les écritures.
 * Les routes de consultation héritaient donc d'une authentification sans
 * jamais dire **qui** avait le droit de lire — et n'importe quel parent
 * connecté pouvait lister les élèves de l'établissement.
 *
 * Corriger les trois cas connus n'aurait rien empêché : c'est le motif par
 * défaut du projet qui était faux. Ce test parcourt la table de routage
 * d'Express et échoue dès qu'une route oublie son garde de rôle, y compris
 * une route ajoutée dans six mois par quelqu'un qui n'a pas lu cette
 * conversation.
 */

/**
 * Routes volontairement publiques : elles s'exécutent avant qu'un token
 * existe. Express 5 n'expose plus le préfixe de montage des routeurs, elles
 * sont donc identifiées par leur chemin relatif.
 */
const ROUTES_PUBLIQUES = new Set([
  'GET /health',
  'POST /login',
  'POST /refresh',
  'POST /logout',
  'POST /forgot-password',
  'POST /reset-password',
]);

interface Route {
  methode: string;
  chemin: string;
  gardes: string[];
}

/**
 * Parcourt récursivement la pile de routage d'Express.
 *
 * `heritees` propage les middlewares montés au niveau d'un routeur
 * (`router.use(requireAuth, requireRole('admin'))`) : ils ne figurent pas dans
 * la pile des routes qu'ils protègent, mais s'appliquent bien à elles.
 */
function listerRoutes(stack: unknown[], prefixe = '', heritees: string[] = []): Route[] {
  const routes: Route[] = [];
  const acquises = [...heritees];

  for (const couche of stack as {
    name?: string;
    route?: { path: string; methods: Record<string, boolean>; stack: { name?: string }[] };
    handle?: { stack?: unknown[] };
    regexp?: RegExp;
    path?: string;
  }[]) {
    if (couche.route) {
      const chemin = `${prefixe}${couche.route.path}`.replace(/\/+$/, '') || '/';
      for (const methode of Object.keys(couche.route.methods)) {
        routes.push({
          methode: methode.toUpperCase(),
          chemin,
          gardes: [...acquises, ...couche.route.stack.map((c) => c.name ?? '')],
        });
      }
      continue;
    }

    if (couche.handle?.stack) {
      routes.push(
        ...listerRoutes(couche.handle.stack, prefixe + montagePathDe(couche), acquises),
      );
      continue;
    }

    // Middleware simple monté sur ce routeur : il couvre les routes suivantes.
    if (couche.name) acquises.push(couche.name);
  }

  return routes;
}

/** Reconstitue le préfixe de montage, au mieux de ce qu'Express expose. */
function montagePathDe(couche: { regexp?: RegExp; path?: string }): string {
  if (couche.path && couche.path !== '/') return couche.path;

  const source = couche.regexp?.source;
  if (!source) return '';

  const match = /\^\\?\/([\w\-/\\]*)/.exec(source);
  const brut = match?.[1]?.replace(/\\\//g, '/').replace(/\\/g, '') ?? '';
  return brut ? `/${brut}` : '';
}

describe('gardes de rôle sur toutes les routes', () => {
  const app = createApp();
  const stack = ((app as unknown as { router?: { stack: unknown[] } }).router ??
    (app as unknown as { _router: { stack: unknown[] } })._router).stack;
  const routes = listerRoutes(stack);

  it('découvre bien la table de routage', () => {
    // Si l'introspection casse (changement de version d'Express), ce test
    // saute le premier : sans lui, les suivants passeraient sur zéro route.
    expect(routes.length).toBeGreaterThan(30);
    // Chemins relatifs (le préfixe de montage n'est plus exposé), mais assez
    // distinctifs pour prouver qu'on descend bien dans les sous-routeurs.
    expect(routes.some((r) => r.chemin === '/:id/coefficients/:classId')).toBe(true);
    expect(routes.some((r) => r.chemin === '/:id/bulletin/export')).toBe(true);
    expect(routes.every((r) => r.gardes.length > 0)).toBe(true);
  });

  it('déclare un rôle explicite sur chaque route authentifiée', () => {
    // Le vrai critère : une route protégée par requireAuth sans requireRole
    // laisse « qui a le droit de lire » indéfini. C'est ce qui a ouvert les
    // trois fuites.
    const sansRole = routes
      .filter((route) => route.gardes.includes('requireAuth'))
      .filter((route) => !route.gardes.includes('roleGuard'))
      .map((route) => `${route.methode} ${route.chemin}`);

    expect(sansRole).toEqual([]);
  });

  it("n'expose aucune route publique en dehors de la liste connue", () => {
    const publiques = routes
      .filter((route) => !route.gardes.includes('requireAuth'))
      .map((route) => `${route.methode} ${route.chemin}`);

    // Ajouter une route sans authentification devient un choix explicite,
    // pas un oubli.
    expect(publiques.sort()).toEqual([...ROUTES_PUBLIQUES].sort());
  });

  it('place requireAuth avant le garde de rôle', () => {
    // requireRole renvoie 401 sans `req.auth` : monté seul, il masquerait un
    // défaut d'authentification en erreur de rôle.
    const malOrdonnees = routes
      .filter((route) => route.gardes.includes('roleGuard'))
      .filter((route) => {
        const auth = route.gardes.indexOf('requireAuth');
        // requireAuth peut être monté au niveau du routeur : absent de la pile
        // de la route, il est alors déjà passé.
        return auth !== -1 && auth > route.gardes.indexOf('roleGuard');
      })
      .map((route) => `${route.methode} ${route.chemin}`);

    expect(malOrdonnees).toEqual([]);
  });
});
