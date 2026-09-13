-- La creation d'ecole (staff.service.ts) et les deux scripts de seed
-- oubliaient de marquer devoir/composition comme "required" a la creation,
-- contrairement au backfill de la migration precedente qui ne couvrait que
-- les ecoles deja existantes a ce moment-la. Corrige les ecoles creees dans
-- l'intervalle.
--
-- Condition restreinte au libelle/poids/position par defaut encore intacts :
-- une ecole ayant deja reconfigure ce type (libelle ou poids modifie) est
-- volontairement laissee de cote, pour ne pas ecraser un choix explicite de
-- desactiver "required" sur un type par ailleurs personnalise. Idempotent :
-- ne fait rien sur une ligne deja a jour.
UPDATE "grade_types"
  SET "required" = true
  WHERE "code" = 'devoir' AND "required" = false
    AND "label" = 'Devoir' AND "weight" = 2 AND "position" = 2;
UPDATE "grade_types"
  SET "required" = true
  WHERE "code" = 'composition' AND "required" = false
    AND "label" = 'Composition' AND "weight" = 3 AND "position" = 3;
