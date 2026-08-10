-- Rattache une classe a une annee scolaire (comme les periodes) et prepare la
-- reinscription : `promotes_to_id` designe la classe superieure ou les eleves
-- de celle-ci sont censes passer l'annee suivante ("CP" -> "CE1").
--
-- Rattachement optionnel, comme pour les periodes : une classe non rattachee
-- continue de fonctionner exactement comme avant, aucune migration de donnees
-- n'est necessaire pour les ecoles deja en production.

-- AlterTable
ALTER TABLE "classes"
  ADD COLUMN "school_year_id" INTEGER,
  ADD COLUMN "promotes_to_id" INTEGER;

-- CreateIndex
CREATE INDEX "classes_school_year_id_idx" ON "classes"("school_year_id");

-- AddForeignKey
-- RESTRICT explicite, comme pour terms.school_year_id : une annee scolaire ne
-- peut pas etre supprimee definitivement tant qu'une classe y est encore
-- rattachee. deleteSchoolYearPermanently detache d'abord les classes.
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_year_id_fkey" FOREIGN KEY ("school_year_id") REFERENCES "school_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Composite, comme classes_homeroom_teacher_id_school_id_fkey : la classe
-- superieure est forcement de la meme ecole. Restrict explicite pour la meme
-- raison (school_id n'est pas nullable).
ALTER TABLE "classes" ADD CONSTRAINT "classes_promotes_to_id_school_id_fkey" FOREIGN KEY ("promotes_to_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
