/**
 * Normalisation des identifiants de connexion.
 *
 * À appliquer À L'ÉCRITURE comme à la lecture. Normaliser seulement à la
 * lecture enfermerait dehors tout compte créé avec une majuscule : la
 * recherche chercherait `parent@ecole.test` alors que la base contient
 * `Parent@Ecole.test`.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Supprime espaces, points et séparateurs d'un numéro saisi à la main. */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s.\-()]/g, '');
}
