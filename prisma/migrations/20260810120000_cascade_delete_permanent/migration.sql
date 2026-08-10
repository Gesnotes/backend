-- La suppression definitive de Classe/Matiere/Periode/Annee scolaire ne doit
-- plus etre bloquee par des donnees rattachees : elle les emporte en cascade,
-- comme deleteStudentPermanently et deleteTermPermanently le font deja.
-- Les FK RESTRICT qui empechaient jusqu'ici la suppression (ou forcaient un
-- contournement applicatif) passent en CASCADE. Deux exceptions restent en
-- RESTRICT (classes_promotes_to_id_school_id_fkey, classes_homeroom_teacher_id_
-- school_id_fkey) : composites avec school_id non nullable, un SET NULL y
-- echouerait a l'execution -- les services detachent ces deux colonnes
-- explicitement avant de supprimer, comme deleteSchoolYearPermanently le
-- fait deja pour school_year_id.

-- AlterTable: une classe supprimee emporte ses eleves (et donc leurs notes,
-- presences et liens parents, deja en cascade depuis Student).
ALTER TABLE "students" DROP CONSTRAINT "students_class_id_fkey";
ALTER TABLE "students" ADD CONSTRAINT "students_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: une matiere supprimee emporte ses evaluations et ses notes.
ALTER TABLE "evaluations" DROP CONSTRAINT "evaluations_subject_id_fkey";
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "grades" DROP CONSTRAINT "grades_subject_id_fkey";
ALTER TABLE "grades" ADD CONSTRAINT "grades_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: une periode supprimee emporte ses evaluations et ses notes
-- (deleteTermPermanently n'a donc plus besoin de les vider a la main).
ALTER TABLE "evaluations" DROP CONSTRAINT "evaluations_term_id_fkey";
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "grades" DROP CONSTRAINT "grades_term_id_fkey";
ALTER TABLE "grades" ADD CONSTRAINT "grades_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: une annee scolaire supprimee emporte ses periodes et ses
-- classes (qui emportent elles-memes tout ce qui precede).
ALTER TABLE "terms" DROP CONSTRAINT "terms_school_year_id_fkey";
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_year_id_fkey" FOREIGN KEY ("school_year_id") REFERENCES "school_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "classes" DROP CONSTRAINT "classes_school_year_id_fkey";
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_year_id_fkey" FOREIGN KEY ("school_year_id") REFERENCES "school_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;
