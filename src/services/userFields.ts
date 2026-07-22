/**
 * Champs utilisateur exposables par l'API.
 *
 * Source unique. Ces listes étaient auparavant redéfinies dans quatre
 * services, avec des contenus déjà divergents : la garantie « ne jamais
 * renvoyer `passwordHash` » reposait sur la mémoire de celui qui écrivait le
 * `select` suivant. Ajouter un champ sensible à `User` obligeait à se souvenir
 * de quatre endroits.
 */

/** Identité seule : ce qu'on peut montrer à n'importe quel utilisateur. */
export const identityFields = {
  id: true,
  firstName: true,
  lastName: true,
} as const;

/**
 * Identité + coordonnées. Réservé à l'administration : un enseignant n'a pas
 * à disposer de l'annuaire des familles, un parent encore moins.
 */
export const contactFields = {
  ...identityFields,
  email: true,
  phone: true,
} as const;

/** Vue administrative complète d'un compte, cycle de vie compris. */
export const accountFields = {
  ...contactFields,
  archivedAt: true,
  createdAt: true,
} as const;
