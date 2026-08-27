-- Types de note configurables par ecole (jusqu'ici seed une fois a la
-- creation de l'ecole, sans aucune route pour les modifier ensuite).
--
-- "required" remplace la comparaison en dur sur code = 'devoir' / 'composition'
-- dans grading/compute.ts : une moyenne de matiere n'est publiee que si
-- l'eleve a au moins une note de chaque type marque obligatoire.
--
-- Le bulletin PDF (bulletin/pdf.ts) devient lui aussi flexible : une colonne
-- par type de note actif de l'ecole, plus les 3 colonnes fixes
-- interrogation/devoir/composition d'avant - pas besoin d'un champ
-- supplementaire pour ca, l'ordre existant (position) suffit.
--
-- Pas de CASCADE sur grades.grade_type_id / evaluations.grade_type_id : elles
-- restent en RESTRICT (jamais touchees par la migration
-- 20260810120000_cascade_delete_permanent) - contrairement aux periodes et
-- annees scolaires, un type de note utilise doit bloquer sa suppression
-- definitive, jamais entrainer ses notes avec lui.

-- AlterTable
ALTER TABLE "grade_types"
  ADD COLUMN "required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archived_at" TIMESTAMPTZ(6);

-- Backfill : toutes les ecoles existantes n'ont aujourd'hui que ces 3 codes
-- exacts (referentiel ferme jusqu'ici) - restaure le comportement actuel a
-- l'identique avant d'ouvrir la configuration.
UPDATE "grade_types" SET "required" = true WHERE "code" = 'devoir';
UPDATE "grade_types" SET "required" = true WHERE "code" = 'composition';
