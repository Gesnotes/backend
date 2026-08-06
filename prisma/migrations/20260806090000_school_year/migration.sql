-- Annees scolaires : regroupent les periodes (trimestres/semestres) d'une
-- meme rentree.
--
-- Rattachement optionnel pour les periodes existantes : `terms.school_year_id`
-- est nullable et sans valeur par defaut a renseigner. Une periode qui n'est
-- rattachee a aucune annee continue de fonctionner exactement comme avant --
-- aucune migration de donnees n'est necessaire pour les ecoles deja en
-- production. Le rattachement se fait a la creation d'une nouvelle annee, ou
-- en modifiant une periode existante.

-- CreateTable
CREATE TABLE "school_years" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "archived_at" TIMESTAMP(6),

    CONSTRAINT "school_years_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "school_years_school_id_archived_at_idx" ON "school_years"("school_id", "archived_at");

-- AddForeignKey
ALTER TABLE "school_years" ADD CONSTRAINT "school_years_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "terms" ADD COLUMN "school_year_id" INTEGER;

-- CreateIndex
CREATE INDEX "terms_school_year_id_idx" ON "terms"("school_year_id");

-- AddForeignKey
-- RESTRICT explicite, comme pour les autres references de Term : une annee
-- scolaire ne peut pas etre supprimee definitivement tant qu'une periode y
-- est encore rattachee. Le service detache les periodes (school_year_id a
-- NULL) avant de supprimer l'annee -- voir deleteSchoolYearPermanently.
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_year_id_fkey" FOREIGN KEY ("school_year_id") REFERENCES "school_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
