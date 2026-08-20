-- Personnalisation du bulletin PDF par ecole : texte libre en en-tete (sous
-- le nom de l'ecole) et en pied de page (au-dessus de la mention generique).
-- Optionnelles, comme les coordonnees de Parametres.

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "bulletin_header" TEXT,
ADD COLUMN "bulletin_footer" TEXT;
