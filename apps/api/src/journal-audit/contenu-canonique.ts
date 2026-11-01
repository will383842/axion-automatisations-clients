import { createHash } from "node:crypto";

// Contenu canonique d'une ligne du journal : le MÊME texte que la fonction SQL public.audit_contenu (ADR 0042), pour que la
// vérification de la chaîne (T2-10) recalcule chaque empreinte hors de la base. Le test d'intégration compare les deux sur 100 lignes.
// Les champs arrivent déjà au format de PostgreSQL : l'identifiant et les jsonb en texte (`::text`, clés rangées par PostgreSQL),
// l'IP par abbrev(ip), la date en UTC à la microseconde (Date perdrait les microsecondes). Le lecteur SQL de verifier.ts les produit.
export interface LigneJournal {
  id: string;
  tenant_id: string | null;
  acteur: string;
  action: string;
  entite: string;
  entite_id: string | null;
  ancienne: string | null;
  nouvelle: string | null;
  ip: string | null;
  cree: string;
  empreinte_precedente: string | null;
  empreinte: string;
}

// jsonb_build_array(...)::text sépare les éléments par « , » ; un texte est échappé comme JSON.stringify le fait (guillemet, barre, contrôles).
const texte = (v: string | null): string => (v === null ? "null" : JSON.stringify(v));
const brut = (v: string | null): string => v ?? "null";

export function contenuCanonique(l: LigneJournal): string {
  return `[${[l.id, texte(l.tenant_id), texte(l.acteur), texte(l.action), texte(l.entite), texte(l.entite_id), brut(l.ancienne), brut(l.nouvelle), texte(l.ip), texte(l.cree)].join(", ")}]`;
}

// empreinte = sha256(empreinte_precedente || contenu canonique), la précédente absente valant le texte vide (audit_inserer).
export function empreinteDe(precedente: string | null, l: LigneJournal): string {
  return createHash("sha256").update((precedente ?? "") + contenuCanonique(l), "utf8").digest("hex");
}
