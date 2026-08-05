import { z } from 'zod';

/**
 * Messages de validation en français.
 *
 * Zod répond en anglais par défaut : « Invalid email address », « Too small:
 * expected string to have >=1 characters ». Ces textes remontent tels quels à
 * l'utilisateur — un secrétariat lisait donc de l'anglais technique là où il
 * attendait « Adresse email invalide ».
 *
 * Chargé pour ses effets de bord, une seule fois, avant que la moindre requête
 * ne soit validée. La configuration agit à l'analyse et non à la construction
 * des schémas : l'importer depuis `app.ts` suffit, quel que soit l'ordre des
 * autres imports.
 */
z.config(z.locales.fr());
