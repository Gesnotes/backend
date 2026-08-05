-- Reouverture temporaire de la saisie sur une periode terminee.
--
-- Un enseignant ne peut plus ecrire sur un trimestre dont la date de fin est
-- passee. Sans soupape, la moindre correction obligeait l administration a
-- saisir a la place du professeur, ou a repousser la date de fin du trimestre
-- — ce qui fausse le calcul de la periode en cours.

-- AlterTable
ALTER TABLE "terms" ADD COLUMN "reopened_until" TIMESTAMP(6);
