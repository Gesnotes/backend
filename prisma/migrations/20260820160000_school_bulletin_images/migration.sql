-- Remplace le texte libre d'en-tete/pied de page du bulletin par des images
-- televersees par l'ecole : le rendu texte ne convenait pas pour un en-tete
-- deja mis en forme (logo, cachet officiel...).

-- AlterTable
ALTER TABLE "schools" DROP COLUMN "bulletin_header",
DROP COLUMN "bulletin_footer",
ADD COLUMN "bulletin_header_image" BYTEA,
ADD COLUMN "bulletin_header_image_type" VARCHAR(50),
ADD COLUMN "bulletin_footer_image" BYTEA,
ADD COLUMN "bulletin_footer_image_type" VARCHAR(50);
