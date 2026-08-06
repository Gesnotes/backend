-- Supervision de la plateforme par l'equipe Gesnotes : comptes staff, hors du
-- perimetre multi-ecoles, et traitement des demandes d'inscription
-- (acceptation -> creation reelle de l'ecole, tracee sur signup_requests).

-- AlterTable : email obligatoire sur la demande (oublie du formulaire
-- d'origine). Aucune ligne existante en base a ce stade : NOT NULL direct,
-- sans backfill.
ALTER TABLE "signup_requests" ADD COLUMN "email" VARCHAR(150) NOT NULL;

-- AlterTable : trace l'ecole reellement creee a partir de la demande.
ALTER TABLE "signup_requests" ADD COLUMN "school_id" INTEGER;

-- AddForeignKey
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "staff_users" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "archived_at" TIMESTAMP(6),
    "sessions_revoked_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateTable
CREATE TABLE "staff_refresh_tokens" (
    "id" SERIAL NOT NULL,
    "staff_user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_refresh_tokens_token_hash_key" ON "staff_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "staff_refresh_tokens_staff_user_id_revoked_at_idx" ON "staff_refresh_tokens"("staff_user_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "staff_refresh_tokens" ADD CONSTRAINT "staff_refresh_tokens_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
