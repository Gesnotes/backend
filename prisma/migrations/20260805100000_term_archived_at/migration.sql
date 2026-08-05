-- Archivage des periodes.
--
-- `evaluations.term_id` et `grades.term_id` sont en RESTRICT : une periode qui
-- porte des evaluations ne peut pas etre effacee, et le DELETE remontait au
-- client en 500. L'archivage devient le comportement par defaut (comme pour les
-- classes et les eleves) ; la suppression definitive reste possible depuis les
-- archives, en cascade explicite.

-- AlterTable
ALTER TABLE "terms" ADD COLUMN "archived_at" TIMESTAMP(6);

-- CreateIndex
CREATE INDEX "terms_school_id_archived_at_idx" ON "terms"("school_id", "archived_at");
