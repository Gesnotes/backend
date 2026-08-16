-- La table student_parents n'avait ni school_id ni cle etrangere composite :
-- rien en base n'empechait de lier un parent d'une ecole a un eleve d'une
-- autre. Seul attachParent (student.service.ts) y ecrit aujourd'hui et
-- verifie deja les deux cotes, mais ce garde-fou protege tout futur point
-- d'ecriture qui oublierait ce controle applicatif -- meme recette que
-- teacher_assignments (20260722200000_teacher_assignment_school_integrity).

-- AlterTable
-- Ajout en trois temps : une colonne NOT NULL sans defaut echouerait sur
-- toute table deja peuplee. L'ecole est deduite de l'eleve, qui porte deja
-- la sienne.
ALTER TABLE "student_parents" ADD COLUMN "school_id" INTEGER;

UPDATE "student_parents" sp
SET "school_id" = s."school_id"
FROM "students" s
WHERE s."id" = sp."student_id";

-- Filet : un lien deja incoherent (parent et eleve d'ecoles differentes)
-- ferait echouer la cle etrangere composite ci-dessous avec un message
-- illisible. On le signale explicitement avant.
DO $$
DECLARE incoherents INT;
BEGIN
  SELECT COUNT(*) INTO incoherents
  FROM "student_parents" sp
  JOIN "users" u ON u."id" = sp."parent_user_id"
  WHERE u."school_id" <> sp."school_id";

  IF incoherents > 0 THEN
    RAISE EXCEPTION 'Migration impossible : % lien(s) parent-eleve melangent plusieurs ecoles. Corrigez-les avant de rejouer.', incoherents;
  END IF;
END $$;

ALTER TABLE "student_parents" ALTER COLUMN "school_id" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "student_parents" DROP CONSTRAINT "student_parents_student_id_fkey";

-- DropForeignKey
ALTER TABLE "student_parents" DROP CONSTRAINT "student_parents_parent_user_id_fkey";

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_parent_user_id_school_id_fkey" FOREIGN KEY ("parent_user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;
