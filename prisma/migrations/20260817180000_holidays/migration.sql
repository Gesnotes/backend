-- Jours feries/conges de l'ecole, exclus du calcul "classes sans appel" du
-- tableau de bord admin. Pas de contrainte unique (school_id, date) : comme
-- pour terms, le doublon n'est controle qu'entre jours actifs cote service,
-- pour ne pas bloquer la recreation d'un jour apres archivage d'un doublon.

-- CreateTable
CREATE TABLE "holidays" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "label" VARCHAR(150) NOT NULL,
    "archived_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "holidays_school_id_date_idx" ON "holidays"("school_id", "date");

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
