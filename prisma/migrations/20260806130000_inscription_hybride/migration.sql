-- Inscription hybride : le formulaire public capte une demande de rappel
-- (aucune ecole ni compte n'existe encore), et school.city desambiguise deux
-- ecoles de meme nom dans la recherche "Quelle est votre ecole ?" (connexion
-- sans sous-domaine).

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "city" VARCHAR(100);

-- CreateEnum
CREATE TYPE "signup_request_status" AS ENUM ('nouveau', 'traite');

-- CreateTable
CREATE TABLE "signup_requests" (
    "id" SERIAL NOT NULL,
    "school_name" VARCHAR(150) NOT NULL,
    "contact_name" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "levels" TEXT[],
    "status" "signup_request_status" NOT NULL DEFAULT 'nouveau',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signup_requests_status_created_at_idx" ON "signup_requests"("status", "created_at");
