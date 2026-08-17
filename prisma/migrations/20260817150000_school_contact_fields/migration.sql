-- Coordonnees de l'ecole affichees et editables dans Parametres.
-- Purement declaratives : contrairement a l'email/telephone d'un User, rien
-- ne s'en sert pour la connexion ni pour desambiguiser une ecole a l'identify.

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "email" VARCHAR(150),
ADD COLUMN "phone" VARCHAR(30),
ADD COLUMN "address" VARCHAR(255);
