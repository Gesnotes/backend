-- grade_types.archived_at avait ete cree en timestamptz alors que toutes les
-- autres colonnes "archived_at" du schema (students, classes, terms,
-- school_years...) sont en timestamp sans fuseau. Alignement pour eviter une
-- conversion de fuseau silencieuse sur cette seule colonne si la session
-- Postgres n'est pas en UTC.
ALTER TABLE "grade_types" ALTER COLUMN "archived_at" TYPE TIMESTAMP(6);
