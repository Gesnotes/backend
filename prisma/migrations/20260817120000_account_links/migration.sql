-- Liaison explicite entre deux comptes utilisateurs de la meme personne
-- reelle, quand identify() ne peut pas les rapprocher automatiquement
-- (identifiants differents -- ex. un enseignant qui est aussi parent dans
-- la meme ecole). Toujours creee en double ligne symetrique par le service
-- (owner->linked et linked->owner) : la contrainte unique porte donc sur le
-- couple dans un seul sens, la symetrie etant une garantie applicative.

-- CreateTable
CREATE TABLE "account_links" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "linked_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_links_owner_user_id_linked_user_id_key" ON "account_links"("owner_user_id", "linked_user_id");

-- AddForeignKey
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_linked_user_id_fkey" FOREIGN KEY ("linked_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
