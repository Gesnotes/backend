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
 * Un numéro exploitable : indicatif international facultatif, puis 8 à 15
 * chiffres.
 *
 * Le téléphone est un identifiant de connexion au même titre que l'email. Un
 * numéro mal saisi ne se voit pas à la création — il se découvre le jour où le
 * parent n'arrive pas à se connecter, et personne ne fait le lien. La borne
 * haute est celle d'E.164 ; la borne basse laisse passer les formats locaux
 * (huit chiffres au Bénin) comme les numéros préfixés de leur indicatif.
 */
export function isValidPhone(phone: string): boolean {
  return /^\+?\d{8,15}$/.test(normalizePhone(phone.trim()));
}

/** Message unique, pour que backend et interface disent la même chose. */
export const PHONE_FORMAT_MESSAGE =
  'Numéro invalide : 8 à 15 chiffres, avec l’indicatif au besoin (ex. +229 01 97 00 00 00).';

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
