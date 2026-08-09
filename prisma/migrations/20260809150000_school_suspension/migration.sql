-- Suspension d'une ecole par l'equipe Gesnotes (impaye, litige, fermeture...),
-- distincte de la suppression definitive : les comptes de l'ecole ne peuvent
-- plus se connecter, mais rien n'est detruit. Meme pattern archiver ->
-- restaurer -> supprimer definitivement que Class/Student/Term/SchoolYear.

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "archived_at" TIMESTAMP(6);

-- CreateIndex
CREATE INDEX "schools_archived_at_idx" ON "schools"("archived_at");
