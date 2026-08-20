-- Miroir de "password_reset_tokens" pour les comptes staff : table dediee
-- plutot que reutiliser la table des users d'ecole, un compte staff n'en
-- est pas un (voir "staff_refresh_tokens" pour le meme choix).

-- CreateTable
CREATE TABLE "staff_password_reset_tokens" (
    "id" SERIAL NOT NULL,
    "staff_user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "used_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_password_reset_tokens_token_hash_key" ON "staff_password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "staff_password_reset_tokens_staff_user_id_used_at_idx" ON "staff_password_reset_tokens"("staff_user_id", "used_at");

-- AddForeignKey
ALTER TABLE "staff_password_reset_tokens" ADD CONSTRAINT "staff_password_reset_tokens_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
