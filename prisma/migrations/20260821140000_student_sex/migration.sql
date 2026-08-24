-- Sexe de l'eleve : optionnel, sert uniquement a la case "Sexe" du bulletin
-- imprime. Jamais requis a la creation, une ecole qui ne le renseigne pas
-- voit juste un champ vide sur le document.

-- CreateEnum
CREATE TYPE "sex" AS ENUM ('M', 'F');

-- AlterTable
ALTER TABLE "students" ADD COLUMN "sex" "sex";
