-- Index manquants pour GET /teachers/:id/detail : sans eux, filtrer les
-- notes/presences d'un enseignant precis (teacher_user_id / recorded_by_user_id)
-- scanne toute la table grades/attendances de la plateforme, aucun index
-- existant ne portant ces colonnes en tete.

-- CreateIndex
CREATE INDEX "grades_teacher_user_id_created_at_idx" ON "grades"("teacher_user_id", "created_at");

-- CreateIndex
CREATE INDEX "attendances_recorded_by_user_id_date_idx" ON "attendances"("recorded_by_user_id", "date");
