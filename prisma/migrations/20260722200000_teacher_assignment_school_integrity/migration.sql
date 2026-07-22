-- DropForeignKey
ALTER TABLE "teacher_assignments" DROP CONSTRAINT "teacher_assignments_class_id_fkey";

-- DropForeignKey
ALTER TABLE "teacher_assignments" DROP CONSTRAINT "teacher_assignments_subject_id_fkey";

-- DropForeignKey
ALTER TABLE "teacher_assignments" DROP CONSTRAINT "teacher_assignments_teacher_user_id_fkey";

-- AlterTable
-- Ajout en trois temps : une colonne NOT NULL sans defaut echouerait sur
-- toute table deja peuplee. L'ecole est deduite de la classe, qui porte deja
-- la sienne.
ALTER TABLE "teacher_assignments" ADD COLUMN     "school_id" INTEGER;

UPDATE "teacher_assignments" ta
SET "school_id" = c."school_id"
FROM "classes" c
WHERE c."id" = ta."class_id";

-- Filet : une affectation deja incoherente (classe et matiere d'ecoles
-- differentes) ferait echouer les cles etrangeres ci-dessous avec un message
-- illisible. On la signale explicitement avant.
DO $$
DECLARE incoherentes INT;
BEGIN
  SELECT COUNT(*) INTO incoherentes
  FROM "teacher_assignments" ta
  JOIN "subjects" s ON s."id" = ta."subject_id"
  JOIN "users" u ON u."id" = ta."teacher_user_id"
  WHERE s."school_id" <> ta."school_id" OR u."school_id" <> ta."school_id";

  IF incoherentes > 0 THEN
    RAISE EXCEPTION 'Migration impossible : % affectation(s) melangent plusieurs ecoles. Corrigez-les avant de rejouer.', incoherentes;
  END IF;
END $$;

ALTER TABLE "teacher_assignments" ALTER COLUMN "school_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "classes_id_school_id_key" ON "classes"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_id_school_id_key" ON "subjects"("id", "school_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_idx" ON "teacher_assignments"("school_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_school_id_key" ON "users"("id", "school_id");

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_teacher_user_id_school_id_fkey" FOREIGN KEY ("teacher_user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_subject_id_school_id_fkey" FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;
