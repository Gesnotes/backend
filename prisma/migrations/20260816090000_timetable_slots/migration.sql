-- Emploi du temps : creneaux recurrents (jour de semaine + horaire) pour
-- une affectation enseignant x classe x matiere. Permet a chaque enseignant
-- de faire l'appel de presence pendant son propre cours plutot que par le
-- seul referent de la classe, une fois par jour.
--
-- Ne concerne que les classes en mode `notes` -- les classes `presence`
-- (maternelle/garderie) gardent le flux historique, sans creneau.
--
-- Cette migration pose uniquement le schema de l'emploi du temps : elle ne
-- touche pas `attendances`, qui restera sur son modele actuel (un statut par
-- eleve et par jour) tant que les ecoles n'ont pas rempli leur planning. La
-- bascule de la presence sur les creneaux vient dans une migration separee.

-- CreateIndex
-- Cible de la cle etrangere composite de TimetableSlot, meme recette que
-- pour classes/subjects/users (voir 20260722200000_teacher_assignment_school_integrity).
CREATE UNIQUE INDEX "teacher_assignments_id_school_id_key" ON "teacher_assignments"("id", "school_id");

-- CreateEnum
CREATE TYPE "weekday" AS ENUM ('lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche');

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "teacher_assignment_id" INTEGER NOT NULL,
    "day_of_week" "weekday" NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "archived_at" TIMESTAMP(6),

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_id_school_id_key" ON "timetable_slots"("id", "school_id");

-- CreateIndex
CREATE INDEX "timetable_slots_school_id_day_of_week_archived_at_idx" ON "timetable_slots"("school_id", "day_of_week", "archived_at");

-- CreateIndex
CREATE INDEX "timetable_slots_teacher_assignment_id_day_of_week_archived_idx" ON "timetable_slots"("teacher_assignment_id", "day_of_week", "archived_at");

-- AddForeignKey
-- Cascade : supprimer une affectation emporte ses creneaux *inutilises*. Un
-- creneau qui a deja de la presence enregistree sera protege en RESTRICT par
-- Attendance.slot (migration a venir), qui bloque alors toute la chaine.
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_teacher_assignment_id_school_id_fkey" FOREIGN KEY ("teacher_assignment_id", "school_id") REFERENCES "teacher_assignments"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;
