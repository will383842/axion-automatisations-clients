-- T2-44b-a : une seule fin de contrat par client (dette LOT2-dette-T2-44-lancer-idempotent). Sert d'arbitre à INSERT … ON CONFLICT (tenant_id) DO NOTHING (routes/fin-de-contrat.ts, port lancer).
-- ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME, ALTER … TYPE, ALTER POLICY ; aucune colonne, aucune valeur d'énumération, aucune fonction ; aucune ligne lue ni modifiée.
-- Échec fermé : si un client a déjà deux lignes, la contrainte échoue et RIEN n'est appliqué (une transaction). Jamais de nettoyage pour faire passer la migration : ESCALADE à Will.
-- L'index non unique fins_de_contrat_tenant_id_idx (0005) devient redondant : il est GARDÉ. RLS (activée et forcée, 0005) et droits inchangés.
ALTER TABLE "fins_de_contrat" ADD CONSTRAINT "fins_de_contrat_une_par_client" UNIQUE("tenant_id");
