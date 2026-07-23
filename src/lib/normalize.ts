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

/**
 * Clé de comparaison d'un libellé, insensible à la casse, aux accents et aux
 * espaces superflus.
 *
 * Sert à détecter les quasi-doublons : « Mathématiques » et « Mathematiques »
 * désignent la même matière, mais ce sont deux chaînes différentes. Sans cette
 * normalisation, la garde d'unicité les laisserait coexister — c'est ainsi que
 * deux « Maths » se retrouvaient dans la même liste.
 *
 * On ne stocke pas cette forme : le libellé affiché garde ses accents. Elle ne
 * sert qu'à la comparaison.
 */
export function labelKey(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
