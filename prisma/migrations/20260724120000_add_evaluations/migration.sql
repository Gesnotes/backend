-- Introduit l'entite "evaluation" : une interro/un devoir concret, ce qui
-- permet plusieurs notes du meme type dans une meme periode. Chaque note
-- existante est rattachee a une evaluation par backfill, sans perte.

-- CreateTable
CREATE TABLE "evaluations" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "grade_type_id" INTEGER NOT NULL,
    "term_id" INTEGER NOT NULL,
    "teacher_user_id" INTEGER,
    "label" VARCHAR(120) NOT NULL,
    "date" DATE,
    "max_value" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evaluations_class_id_subject_id_term_id_idx" ON "evaluations"("class_id", "subject_id", "term_id");

-- CreateIndex
CREATE INDEX "evaluations_school_id_idx" ON "evaluations"("school_id");

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_grade_type_id_fkey" FOREIGN KEY ("grade_type_id") REFERENCES "grade_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_teacher_user_id_fkey" FOREIGN KEY ("teacher_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable : colonne d'abord nullable, le temps du backfill.
ALTER TABLE "grades" ADD COLUMN "evaluation_id" INTEGER;

-- ----------------------------------------------------------------------------
-- Backfill : chaque note existante devient une note d'evaluation.
--
-- Le modele precedent collapsait toutes les notes d'un meme type par eleve.
-- Pour n'en perdre aucune, on attribue a chaque note un "slot" = son rang
-- parmi les notes du meme (classe, matiere, type, periode, eleve), trie par
-- date. Les deux interros d'un eleve deviennent "Interrogation 1" et
-- "Interrogation 2". Une evaluation est creee par (classe, matiere, type,
-- periode, slot).
-- ----------------------------------------------------------------------------

-- L'ecole est prise sur la classe (comme Grade l'ancre via l'eleve) : la cle
-- etrangere composite evaluations -> classes est ainsi toujours satisfaite.
CREATE TEMPORARY TABLE "_grade_slots" AS
SELECT
  g."id"            AS grade_id,
  c."school_id"     AS school_id,
  s."class_id"      AS class_id,
  g."subject_id"    AS subject_id,
  g."grade_type_id" AS grade_type_id,
  g."term_id"       AS term_id,
  g."max_value"     AS max_value,
  (ROW_NUMBER() OVER (
     PARTITION BY s."class_id", g."subject_id", g."grade_type_id", g."term_id", g."student_id"
     ORDER BY g."created_at" NULLS FIRST, g."id"
   ) - 1)           AS slot
FROM "grades" g
JOIN "students" s ON s."id" = g."student_id"
JOIN "classes"  c ON c."id" = s."class_id";

-- Colonne temporaire : retient le slot pour rebrancher chaque note sur son
-- evaluation, puis disparait (le schema final ne la connait pas).
ALTER TABLE "evaluations" ADD COLUMN "_slot" INTEGER;

-- Une evaluation par (classe, matiere, type, periode, slot). Le libelle n'est
-- numerote que si le groupe compte plusieurs slots, pour ne pas afficher
-- "Composition 1" quand il n'y en a qu'une.
INSERT INTO "evaluations"
  ("school_id", "class_id", "subject_id", "grade_type_id", "term_id",
   "teacher_user_id", "label", "date", "max_value", "created_at", "_slot")
SELECT
  grp."school_id", grp."class_id", grp."subject_id", grp."grade_type_id", grp."term_id",
  NULL,
  gt."label" || CASE WHEN mx."max_slot" > 0 THEN ' ' || (grp."slot" + 1)::text ELSE '' END,
  NULL,
  grp."max_value",
  CURRENT_TIMESTAMP,
  grp."slot"
FROM (
  SELECT
    "school_id", "class_id", "subject_id", "grade_type_id", "term_id", "slot",
    MODE() WITHIN GROUP (ORDER BY "max_value") AS max_value
  FROM "_grade_slots"
  GROUP BY "school_id", "class_id", "subject_id", "grade_type_id", "term_id", "slot"
) grp
JOIN "grade_types" gt ON gt."id" = grp."grade_type_id"
JOIN (
  SELECT "class_id", "subject_id", "grade_type_id", "term_id", MAX("slot") AS max_slot
  FROM "_grade_slots"
  GROUP BY "class_id", "subject_id", "grade_type_id", "term_id"
) mx
  ON  mx."class_id"      = grp."class_id"
  AND mx."subject_id"    = grp."subject_id"
  AND mx."grade_type_id" = grp."grade_type_id"
  AND mx."term_id"       = grp."term_id";

-- Rebranche chaque note sur son evaluation (cle naturelle + slot).
UPDATE "grades" g
SET "evaluation_id" = e."id"
FROM "_grade_slots" gs
JOIN "evaluations" e
  ON  e."class_id"      = gs."class_id"
  AND e."subject_id"    = gs."subject_id"
  AND e."grade_type_id" = gs."grade_type_id"
  AND e."term_id"       = gs."term_id"
  AND e."_slot"         = gs."slot"
WHERE g."id" = gs."grade_id";

-- Filet : aucune note ne doit rester orpheline avant de poser le NOT NULL.
DO $$
DECLARE orphelines INT;
BEGIN
  SELECT COUNT(*) INTO orphelines FROM "grades" WHERE "evaluation_id" IS NULL;
  IF orphelines > 0 THEN
    RAISE EXCEPTION 'Backfill incomplet : % note(s) sans evaluation. Migration interrompue.', orphelines;
  END IF;
END $$;

ALTER TABLE "evaluations" DROP COLUMN "_slot";
DROP TABLE "_grade_slots";

-- La colonne peut desormais devenir obligatoire.
ALTER TABLE "grades" ALTER COLUMN "evaluation_id" SET NOT NULL;

-- CreateIndex : une seule note par eleve et par evaluation.
CREATE UNIQUE INDEX "grades_evaluation_id_student_id_key" ON "grades"("evaluation_id", "student_id");

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
