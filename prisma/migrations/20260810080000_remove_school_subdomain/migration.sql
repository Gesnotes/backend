-- Elimine le sous-domaine comme mecanisme d'identification d'une ecole.
-- La connexion se fait desormais uniquement par identifiant (email/telephone)
-- + mot de passe, recherche a travers toutes les ecoles (voir auth.service.ts,
-- identify()) ; le JWT fait seul autorite pour school_id sur toute requete
-- authentifiee (schoolContext.ts). Plus aucune route ni page ne route sur un
-- sous-domaine.

-- DropIndex
DROP INDEX IF EXISTS "schools_subdomain_key";

-- AlterTable
ALTER TABLE "schools" DROP COLUMN "subdomain";
