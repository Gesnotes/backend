-- Seuil de moyenne de passage propre a chaque ecole (par defaut 10, comme
-- avant que la valeur ne soit configurable). Purement declaratif : le calcul
-- de la moyenne (compute.ts) ne s'en sert pas, seul l'affichage en tient
-- compte.

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "passing_grade" DECIMAL(4,2) NOT NULL DEFAULT 10;
