import type { NextFunction, Request, Response } from 'express';

/**
 * Marque une route comme volontairement accessible sans authentification.
 *
 * Ne fait rien à l'exécution : c'est une **déclaration**. `route-guards.test`
 * exige que chaque route porte soit un garde de rôle, soit ce marqueur.
 *
 * Reconnaître les routes publiques à leur chemin ne marchait pas : Express 5
 * n'expose plus le préfixe de montage des routeurs, si bien qu'un `POST
 * /login` ajouté sur n'importe quel autre routeur aurait été confondu avec
 * celui de l'authentification et exempté sans alerte. Ouvrir une route au
 * public devient ici un geste visible dans le code, pas une coïncidence de
 * nommage.
 */
export function publicRoute(_req: Request, _res: Response, next: NextFunction) {
  next();
}
