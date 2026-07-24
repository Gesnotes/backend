import crypto from 'node:crypto';

/**
 * Empreinte d'un token opaque (refresh, réinitialisation, invitation).
 *
 * **Source unique.** Ce hachage était implémenté deux fois, dans
 * `auth.service` et dans `invitation.service`, pour des lignes de la *même*
 * table : le jour où l'algorithme change d'un côté, les invitations cessent
 * silencieusement d'être validables par la réinitialisation, qui hache de
 * l'autre.
 *
 * SHA-256 suffit ici : le token est déjà un secret aléatoire de 256 bits ou
 * plus, il n'a pas besoin d'être ralenti comme un mot de passe choisi par un
 * humain.
 */
export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/** Token opaque à usage unique, jamais stocké en clair. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
