-- Journal d'audit, borne a un petit nombre d'actions sensibles (voir
-- audit.service.ts). target_id n'est volontairement pas une cle etrangere :
-- l'entite visee peut avoir disparu depuis, l'entree du journal doit
-- survivre. actor_user_id est en SET NULL pour la meme raison, actor_name/
-- actor_role sont fige a l'ecriture.

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "actor_user_id" INTEGER,
    "actor_name" VARCHAR(150) NOT NULL,
    "actor_role" "role" NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" INTEGER,
    "target_label" VARCHAR(255),
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_school_id_created_at_idx" ON "audit_logs"("school_id", "created_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
