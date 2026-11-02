import { z } from "zod";
import { Enveloppe } from "../../../../packages/contrats/src/c2/enveloppe.js";
import { Fait, TYPES_DE_FAITS } from "../../../../packages/contrats/src/c2/faits.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { idTache, type FileMinimale } from "../files/files.js";

// Récepteur C2 (T2-16a) : réception, dédoublonnage par event_id, ordre par sujet, détection d'un trou.
// Les traitements par type de fait (devis, factures, paiements, fusions) viennent avec T2-16b : ici, un fait est rangé puis mis en file.

export const DELAI_TROU_MS = 10 * 60 * 1000;
export const NOM_TACHE = "traiter-fait-c2";

export interface FaitRange {
  eventId: string;
  type: string;
  sequence: number;
  sujet: string;
}
export interface EtatSujet {
  derniereTraitee: number | null;
  enAttente: { sequence: number; recuLe: number }[];
}
// Port de stockage. `ranger` doit être atomique (INSERT … ON CONFLICT (tenant_id, source, event_id) DO NOTHING) : le client fait partie de la clé.
export interface Depot {
  organisationExiste(tenantId: string): Promise<boolean>;
  ranger(tenantId: string, fait: FaitRange, recuLe: number): Promise<{ neuf: boolean; traite: boolean }>;
  etatSujet(tenantId: string, sujet: string): Promise<EtatSujet>;
}
// Port du rattrapage : l'adaptateur réel passe par la boîte d'envoi (T2-14) et prend `intention` comme clé anti-doublon.
export interface Rattrapage {
  demander(d: { tenantId: string; sujet: string; apres: number | null; intention: string }): Promise<void>;
}
export interface DepsRecepteur {
  depot: Depot;
  file: FileMinimale;
  rattrapage: Rattrapage;
  maintenant: () => number;
}

export type Decision = { action: "traiter"; sequence: number } | { action: "attendre" } | { action: "rien" } | { action: "rattraper"; manquante: number; apres: number | null };

// Le prochain fait d'un sujet est celui qui suit la dernière séquence traitée (0 si aucune). Un fait plus loin attend ;
// si le plus ancien d'entre eux attend depuis 10 minutes ou plus, le trou est réel : rattrapage.
export function decider(etat: EtatSujet, maintenant: number): Decision {
  if (etat.enAttente.length === 0) return { action: "rien" };
  const attendue = etat.derniereTraitee === null ? 0 : etat.derniereTraitee + 1;
  if (etat.enAttente.some((f) => f.sequence === attendue)) return { action: "traiter", sequence: attendue };
  const apres = etat.enAttente.filter((f) => f.sequence > attendue);
  if (apres.length === 0) return { action: "rien" };
  const plusAncien = Math.min(...apres.map((f) => f.recuLe));
  return maintenant - plusAncien >= DELAI_TROU_MS ? { action: "rattraper", manquante: attendue, apres: etat.derniereTraitee } : { action: "attendre" };
}

// Une seule demande par trou : l'intention est stable tant que la séquence manquante est la même.
export const intentionRattrapage = (sujet: string, manquante: number) => `rattrapage:${sujet}:${manquante}`;

export async function verifierTrous(deps: Pick<DepsRecepteur, "depot" | "rattrapage">, tenantId: string, sujet: string, maintenant: number): Promise<Decision> {
  const decision = decider(await deps.depot.etatSujet(tenantId, sujet), maintenant);
  if (decision.action === "rattraper") await deps.rattrapage.demander({ tenantId, sujet, apres: decision.apres, intention: intentionRattrapage(sujet, decision.manquante) });
  return decision;
}

// Enveloppe lâche : un event_type inconnu d'une console plus ancienne est rangé, jamais jeté.
const EnveloppeLache = Enveloppe.extend({ event_type: z.string().min(1).max(100), payload: z.unknown() });

// L'URL signée du PDF ne sort pas de la réception : ni base, ni file, ni journal (seuls l'échéance et l'empreinte restent).
function sansUrlSignee(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("pdf" in payload)) return payload;
  const { pdf, ...reste } = payload as { pdf: unknown };
  if (typeof pdf !== "object" || pdf === null) return payload;
  const pdfSansUrl = Object.fromEntries(Object.entries(pdf).filter(([cle]) => cle !== "url"));
  return { ...reste, pdf: pdfSansUrl };
}

export async function recevoirFait(deps: DepsRecepteur, corps: unknown): Promise<{ statut: "range" | "deja_recu" }> {
  const brut = EnveloppeLache.safeParse(corps);
  if (!brut.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const e = brut.data;
  if ((TYPES_DE_FAITS as string[]).includes(e.event_type) && !Fait.safeParse(corps).success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const tenantId = e.subject_ref.consoleClientId;
  if (!tenantId) throw new ErreurApi("schema_invalide", "Identifiant console du client absent.");
  if (!(await deps.depot.organisationExiste(tenantId))) throw new ErreurApi("introuvable", "Client inconnu.");
  const fait: FaitRange = { eventId: e.event_id, type: e.event_type, sequence: e.sequence, sujet: e.subject_ref.axiCli };
  const { neuf, traite } = await deps.depot.ranger(tenantId, fait, deps.maintenant());
  // Déjà traité : 200 sans rien refaire. Déjà rangé mais pas traité : on remet la tâche (même jobId, BullMQ n'en garde qu'une).
  if (!neuf && traite) return { statut: "deja_recu" };
  await deps.file.add(NOM_TACHE, { tenantId, eventId: e.event_id, sujet: fait.sujet, sequence: e.sequence, type: e.event_type, payload: sansUrlSignee(e.payload) }, { jobId: idTache({ tenantId, type: NOM_TACHE, cle: e.event_id }) });
  await verifierTrous(deps, tenantId, fait.sujet, deps.maintenant());
  return { statut: neuf ? "range" : "deja_recu" };
}
