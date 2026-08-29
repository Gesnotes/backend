-- Photographie de GradeType.required au moment ou chaque periode est creee,
-- pas une lecture en direct de GradeType : "obligatoire" est configurable
-- par l'ecole et peut changer apres coup, ce qui sans cette table ferait
-- varier retroactivement le caractere complet d'un bulletin deja publie
-- pour une periode passee, sans qu'aucune note n'ait change.
CREATE TABLE "term_required_grade_types" (
    "term_id" INTEGER NOT NULL,
    "grade_type_id" INTEGER NOT NULL,

    CONSTRAINT "term_required_grade_types_pkey" PRIMARY KEY ("term_id","grade_type_id")
);

ALTER TABLE "term_required_grade_types"
  ADD CONSTRAINT "term_required_grade_types_term_id_fkey"
  FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "term_required_grade_types"
  ADD CONSTRAINT "term_required_grade_types_grade_type_id_fkey"
  FOREIGN KEY ("grade_type_id") REFERENCES "grade_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill des periodes existantes : aucun historique de "required" n'existe
-- avant cette table, donc le meilleur point de depart possible est l'etat
-- actuellement actif/obligatoire. A partir de maintenant cette photographie
-- ne bouge plus, meme si la configuration change ensuite.
INSERT INTO "term_required_grade_types" ("term_id", "grade_type_id")
SELECT t."id", gt."id"
FROM "terms" t
JOIN "grade_types" gt ON gt."school_id" = t."school_id" AND gt."required" = true AND gt."archived_at" IS NULL;
