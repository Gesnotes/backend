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
 * Nombre de routes volontairement publiques (`publicRoute`) : /health, les
 * cinq routes d'authentification, les deux routes d'avant-inscription
 * (recherche d'école, demande de rappel), et les trois routes de session de
 * l'équipe Gesnotes (login/refresh/logout, hors périmètre multi-écoles). Le
 * compte est figé pour qu'en ouvrir une douzième soit un geste conscient,
 * pas un effet de bord.
 */
const ROUTES_PUBLIQUES_ATTENDUES = 11;

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
      // Express 5 n'expose plus le préfixe de montage : les chemins restent
      // relatifs. Sans conséquence, les assertions ne portent que sur les
      // gardes — c'est précisément pourquoi `publicRoute` est un marqueur et
      // non une liste de chemins.
      routes.push(...listerRoutes(couche.handle.stack, prefixe, acquises));
      continue;
    }

    // Middleware simple monté sur ce routeur : il couvre les routes suivantes.
    if (couche.name) acquises.push(couche.name);
  }

  return routes;
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

  it('déclare un rôle explicite, ou son ouverture au public, sur chaque route', () => {
    // Le critère ne dépend d'aucun chemin : chaque route doit dire ce qu'elle
    // est. Un `requireAuth` seul laisse « qui a le droit de lire » indéfini —
    // c'est ce qui a ouvert les trois fuites. `requireStaffAuth` compte
    // pareillement : les routes /staff n'ont qu'un seul niveau d'accès
    // (l'équipe Gesnotes), il n'y a pas de rôle à distinguer par-dessus.
    const indecises = routes
      .filter((route) => !route.gardes.includes('roleGuard'))
      .filter((route) => !route.gardes.includes('publicRoute'))
      .filter((route) => !route.gardes.includes('requireStaffAuth'))
      .map((route) => `${route.methode} ${route.chemin}`);

    expect(indecises).toEqual([]);
  });

  it("n'ouvre pas de nouvelle route au public sans le décider", () => {
    const publiques = routes.filter((route) => route.gardes.includes('publicRoute'));
    expect(publiques).toHaveLength(ROUTES_PUBLIQUES_ATTENDUES);

    // Et une route publique ne porte jamais de garde de rôle : les deux
    // marqueurs ensemble signaleraient une intention confuse.
    expect(publiques.filter((r) => r.gardes.includes('roleGuard'))).toEqual([]);
  });

  it('place requireAuth (ou requireStaffAuth) sur toute route non publique', () => {
    const sansAuth = routes
      .filter((route) => !route.gardes.includes('publicRoute'))
      .filter((route) => !route.gardes.includes('requireAuth'))
      .filter((route) => !route.gardes.includes('requireStaffAuth'))
      .map((route) => `${route.methode} ${route.chemin}`);

    expect(sansAuth).toEqual([]);
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
