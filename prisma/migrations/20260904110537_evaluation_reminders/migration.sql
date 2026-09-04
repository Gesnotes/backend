-- Rappel automatique aux parents, 3 jours avant une evaluation programmee.
-- reminder_sent_at evite un double envoi si le job tourne plus d'une fois
-- le meme jour (redemarrage du serveur, etc).
ALTER TABLE "evaluations" ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(6);

-- Nouvelles valeurs d'enum : jamais utilisees dans CETTE migration (ADD
-- VALUE ne peut pas etre suivi d'un usage dans la meme transaction).
ALTER TYPE "notification_type" ADD VALUE 'rappel';
ALTER TYPE "notification_resource_type" ADD VALUE 'evaluation';
