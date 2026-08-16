-- Bascule la presence des classes mode `notes` sur les creneaux de l'emploi
-- du temps : chaque enseignant fait desormais l'appel pendant son propre
-- cours, au lieu du seul referent une fois par jour pour toute la classe.
-- Les classes mode `presence` (maternelle/garderie) gardent exactement leur
-- flux actuel -- slot_id y reste NULL pour toujours.
--
-- Prisma ne sait pas exprimer un index unique PARTIEL (WHERE slot_id IS
-- [NOT] NULL) : @@unique([studentId, date, slotId]) laisserait passer deux
-- lignes a slot_id NULL comme non-dupliquees (NULL <> NULL en SQL), ce qui
-- permettrait deux statuts le meme jour pour une classe mode `presence`. Les
-- deux vrais index uniques ci-dessous sont donc poses a la main.

-- AlterTable
ALTER TABLE "attendances" ADD COLUMN "slot_id" INTEGER;

-- DropIndex
-- Remplace par les deux index uniques partiels ci-dessous.
DROP INDEX "attendances_student_id_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "attendances_student_date_no_slot_key"
  ON "attendances" ("student_id", "date") WHERE "slot_id" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "attendances_student_date_slot_key"
  ON "attendances" ("student_id", "date", "slot_id") WHERE "slot_id" IS NOT NULL;

-- CreateIndex
-- Recherche generale par eleve+jour, independamment du creneau (feuille de
-- presence, saveAttendanceBatch) : ni index unique partiel ci-dessus ne la
-- couvre seul puisqu'aucun ne filtre sur slot_id.
CREATE INDEX "attendances_student_id_date_slot_id_idx" ON "attendances"("student_id", "date", "slot_id");

-- CreateIndex
-- Porte la feuille de presence d'un creneau pour un jour (mode notes).
CREATE INDEX "attendances_slot_id_date_idx" ON "attendances"("slot_id", "date");

-- AddForeignKey
-- RESTRICT explicite : un creneau qui a deja de la presence enregistree ne
-- peut pas etre supprime pour de bon (deleteSlotPermanently le verifie deja
-- cote applicatif, ce filet SQL est le dernier recours si ce controle etait
-- un jour oublie) -- meme raisonnement que term.service.ts.
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_slot_id_school_id_fkey" FOREIGN KEY ("slot_id", "school_id") REFERENCES "timetable_slots"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
