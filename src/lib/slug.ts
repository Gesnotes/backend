/**
 * Identifiant technique stable dérivé d'un texte libre (nom de fichier,
 * `code` d'un référentiel...) — minuscules, sans accents, mots séparés par
 * des tirets.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    // Plage des diacritiques combinants, échappée : écrite en clair, elle
    // serait invisible dans le source et un simple changement d'encodage la
    // corromprait sans qu'aucun test ne le voie.
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
