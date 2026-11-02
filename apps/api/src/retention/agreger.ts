import type { FileMinimale } from "../files/files.js";

// Agrégat quotidien (A-181) : pour la veille, une ligne par client et par instance (exécutions, échecs, durée, coût).
// Gardé sans limite ; le détail des exécutions, lui, est retiré au bout de 90 jours (purger.ts).
// L'écriture REMPLACE la ligne (INSERT … ON CONFLICT (tenant_id, instance_id, jour) DO UPDATE) : relancer la même nuit ne double rien.
// La clé porte le client : deux clients ne partagent jamais une ligne.
export interface LigneExecution {
  jour: string;
  tenantId: string;
  instanceId: string;
  statut: "en_cours" | "reussie" | "echec" | "annulee";
  dureeMs: number | null;
  coutMicroCentimes: number;
}
export interface Agregat {
  tenantId: string;
  instanceId: string;
  jour: string;
  nombre: number;
  echecs: number;
  dureeTotaleMs: number;
  coutMicroCentimes: number;
}
// Port : l'adaptateur SQL lit `executions` du jour (debut en UTC) et écrit par le upsert ci-dessous (SQL_UPSERT_AGREGAT).
export interface DepotAgregats {
  executionsDuJour(jour: string): Promise<LigneExecution[]>;
  // Jours terminés (strictement avant `avant`, AAAA-MM-JJ en UTC) à (re)calculer, du plus ancien au plus récent : ceux qui ont des exécutions
  // ET (aucune ligne d'agrégat, OU une exécution encore `en_cours`, OU une exécution modifiée après l'écriture de l'agrégat).
  // Un agrégat calculé trop tôt (exécution en cours à 02:00 puis terminée) est ainsi refait la nuit suivante ; l'écriture remplace la ligne.
  joursAAgreger(avant: string): Promise<string[]>;
  enregistrer(agregat: Agregat): Promise<void>;
}

export const SQL_UPSERT_AGREGAT =
  "INSERT INTO agregats_quotidiens (tenant_id, id, instance_id, jour, nombre, echecs, duree_totale_ms, cout_micro_centimes, auteur) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8) " +
  "ON CONFLICT (tenant_id, instance_id, jour) DO UPDATE SET nombre = EXCLUDED.nombre, echecs = EXCLUDED.echecs, duree_totale_ms = EXCLUDED.duree_totale_ms, cout_micro_centimes = EXCLUDED.cout_micro_centimes, auteur = EXCLUDED.auteur";

const JOUR_MS = 86_400_000;
export const veilleDe = (maintenant: Date) => new Date(maintenant.getTime() - JOUR_MS).toISOString().slice(0, 10);

function somme(a: number, b: number, nom: string): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw new Error(`borne 2^53-1 dépassée : ${nom}`);
  return s;
}

export function calculerAgregats(lignes: LigneExecution[], jour: string): Agregat[] {
  const parCle = new Map<string, Agregat>();
  for (const l of lignes) {
    const cle = `${l.tenantId}/${l.instanceId}`;
    const a = parCle.get(cle) ?? { tenantId: l.tenantId, instanceId: l.instanceId, jour, nombre: 0, echecs: 0, dureeTotaleMs: 0, coutMicroCentimes: 0 };
    a.nombre = somme(a.nombre, 1, "nombre");
    if (l.statut === "echec") a.echecs = somme(a.echecs, 1, "echecs");
    a.dureeTotaleMs = somme(a.dureeTotaleMs, l.dureeMs ?? 0, "duree");
    a.coutMicroCentimes = somme(a.coutMicroCentimes, l.coutMicroCentimes, "cout");
    parCle.set(cle, a);
  }
  return [...parCle.values()];
}

// Traite TOUS les jours terminés à (re)calculer (nuit manquée, panne, changement d'heure, agrégat calculé trop tôt), pas seulement la veille.
// Les jours sont calculés en UTC : une exécution du 25 octobre à 01:30 à Paris (heure d'hiver) est du 24 à 23:30Z.
export async function agregerVeille(depot: DepotAgregats, maintenant: Date): Promise<{ jours: string[]; agregats: number }> {
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  const jours = await depot.joursAAgreger(aujourdhui);
  // Tout est calculé avant la première écriture : une borne dépassée n'écrit rien.
  const calcules = [];
  for (const jour of jours) calcules.push(...calculerAgregats(await depot.executionsDuJour(jour), jour));
  for (const a of calcules) await depot.enregistrer(a);
  return { jours, agregats: calcules.length };
}

// Une tâche par nuit : même jour, même jobId, BullMQ n'en garde qu'une. Le planificateur nocturne est branché à la mise en service.
export async function enfilerAgregation(file: FileMinimale, maintenant: Date): Promise<void> {
  await file.add("agregat-quotidien", {}, { jobId: `agregat-quotidien-${veilleDe(maintenant)}` });
}
