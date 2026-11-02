import { z } from "zod";
import { Enveloppe } from "../../../../packages/contrats/src/c2/enveloppe.js";
import { Fait, TYPES_DE_FAITS } from "../../../../packages/contrats/src/c2/faits.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { idTache, type FileMinimale } from "../files/files.js";

// Récepteur C2 (T2-16a) : réception, dédoublonnage par event_id, ordre par sujet, détection d'un trou.
// Les traitements par type de fait (devis, factures, paiements, fusions) viennent avec T2-16b : ici, un fait est rangé puis mis en file.

// DETTES (propriétaire = fiche ; critère = test à écrire) :
// - D1 (T2-16b) balayage périodique : aujourd'hui `verifierTrous` n'est appelé qu'à la réception d'un fait, un trou sur un sujet resté muet n'est jamais détecté.
//   Critère : test « un sujet sans nouveau fait, trou de plus de 10 min, déclenche un rattrapage au passage du balayage ».
// - D2 (T2-12) bodyLimit explicite (128 Ko maximum sur la portée du canal, canaux/verifier-entrant.ts et serveur.ts) et limite de débit « c2 » non branchée.
//   Critère : test « un corps de plus de 128 Ko sur la route des faits répond 413 sans rangement » et « au-delà du débit, 429 ».
// - D3 (T2-12) refus d'entrée neutres : horodatage périmé et rejeu ont aujourd'hui des messages distincts ; la règle demande un 401 neutre, et « duplicate » (200) pour un rejeu.
//   Critère : test « horodatage périmé, signature fausse et clé inconnue renvoient le même 401 au même corps ; un rejeu renvoie 200 duplicate ».
// - D4 (T2-16b) si le traitement d'audit.cloture a besoin du contact ou du compte rendu, le demander au Hub à ce moment-là (rien n'est rangé ici : voir CHAMPS_ECARTES).

export const DELAI_TROU_MS = 10 * 60 * 1000;
export const FENETRE_RATTRAPAGE_MS = 60 * 60 * 1000;
export const SEUIL_ALERTE_RATTRAPAGES = 5;
export const NOM_TACHE = "traiter-fait-c2";

export interface FaitRange {
  eventId: string;
  type: string;
  sequence: number;
  sujet: string;
  // Contenu utile du fait, SANS lien ni PII (voir `allegerPayload`) : la base en est la source, la file n'en est qu'une copie.
  payload: unknown;
}
export interface EtatSujet {
  derniereTraitee: number | null;
  enAttente: { sequence: number; recuLe: number }[];
}
// Port de stockage. `ranger` doit être atomique (INSERT … ON CONFLICT (tenant_id, source, event_id) DO NOTHING) : le client fait partie de la clé.
// Il range le payload allégé (colonne jsonb) et renvoie celui qui est EN BASE (celui de la première réception si le fait y était déjà).
export interface Depot {
  organisationExiste(tenantId: string): Promise<boolean>;
  ranger(tenantId: string, fait: FaitRange, recuLe: number): Promise<{ neuf: boolean; traite: boolean; payload: unknown }>;
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
  alerter?: Alerte;
}
export type Alerte = (a: { code: "rattrapage_sans_effet"; sujet: string; manquante: number; essai: number }) => void;

export type Decision = { action: "traiter"; sequence: number } | { action: "attendre" } | { action: "rien" } | { action: "rattraper"; manquante: number; apres: number | null; essai: number };

// Le prochain fait d'un sujet est celui qui suit la dernière séquence traitée (0 si aucune). Un fait plus loin attend ;
// si le plus ancien d'entre eux attend depuis 10 minutes ou plus, le trou est réel : rattrapage.
export function decider(etat: EtatSujet, maintenant: number): Decision {
  if (etat.enAttente.length === 0) return { action: "rien" };
  const attendue = etat.derniereTraitee === null ? 0 : etat.derniereTraitee + 1;
  if (etat.enAttente.some((f) => f.sequence === attendue)) return { action: "traiter", sequence: attendue };
  const apres = etat.enAttente.filter((f) => f.sequence > attendue);
  if (apres.length === 0) return { action: "rien" };
  const plusAncien = Math.min(...apres.map((f) => f.recuLe));
  if (maintenant - plusAncien < DELAI_TROU_MS) return { action: "attendre" };
  // Essai n° 1 dès que le trou a 10 minutes ; un essai de plus à chaque fenêtre tant que le Hub ne l'a pas comblé.
  const essai = Math.floor((maintenant - plusAncien - DELAI_TROU_MS) / FENETRE_RATTRAPAGE_MS) + 1;
  return { action: "rattraper", manquante: attendue, apres: etat.derniereTraitee, essai };
}

// Une seule demande par client, sujet, séquence manquante ET fenêtre d'une heure : si le Hub ne comble pas le trou,
// la fenêtre suivante donne une nouvelle intention, donc une nouvelle demande (la clé anti-doublon ne bloque plus à jamais).
export const intentionRattrapage = (tenantId: string, sujet: string, manquante: number, maintenant: number) =>
  `rattrapage:${tenantId}:${sujet}:${manquante}:${Math.floor(maintenant / FENETRE_RATTRAPAGE_MS)}`;

export async function verifierTrous(deps: Pick<DepsRecepteur, "depot" | "rattrapage" | "alerter">, tenantId: string, sujet: string, maintenant: number): Promise<Decision> {
  const decision = decider(await deps.depot.etatSujet(tenantId, sujet), maintenant);
  if (decision.action === "rattraper") {
    await deps.rattrapage.demander({ tenantId, sujet, apres: decision.apres, intention: intentionRattrapage(tenantId, sujet, decision.manquante, maintenant) });
    // L'alerte ne porte pas l'identifiant du client.
    if (decision.essai > SEUIL_ALERTE_RATTRAPAGES) deps.alerter?.({ code: "rattrapage_sans_effet", sujet, manquante: decision.manquante, essai: decision.essai });
  }
  return decision;
}

// Enveloppe lâche : un event_type inconnu d'une console plus ancienne est rangé, jamais jeté.
const EnveloppeLache = Enveloppe.extend({ event_type: z.string().min(1).max(100), payload: z.unknown() });

// Ce qui est rangé en base et mis en file : le payload sans aucun lien (toute chaîne http/https : URL signée du PDF, lien de compte rendu…)
// et sans les champs de personne. Champs écartés : `contact` (nom, e-mail) et `lienCompteRendu`. Restent, par exemple pour audit.cloture :
// siren, siret, typeAudit, dateAudit, outils, besoins. Pour un pdf : échéance et empreinte seulement. T2-16b redemande au Hub ce dont il aurait besoin en plus.
export const CHAMPS_ECARTES = ["contact", "lienCompteRendu"] as const;
const EST_LIEN = /^https?:\/\//i;
export function allegerPayload(valeur: unknown): unknown {
  if (Array.isArray(valeur)) return valeur.filter((v) => !(typeof v === "string" && EST_LIEN.test(v))).map(allegerPayload);
  if (typeof valeur !== "object" || valeur === null) return valeur;
  return Object.fromEntries(
    Object.entries(valeur)
      .filter(([cle, v]) => !(CHAMPS_ECARTES as readonly string[]).includes(cle) && !(typeof v === "string" && EST_LIEN.test(v)))
      .map(([cle, v]) => [cle, allegerPayload(v)]),
  );
}

const FORME_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recevoirFait(deps: DepsRecepteur, corps: unknown): Promise<{ statut: "range" | "deja_recu" }> {
  const brut = EnveloppeLache.safeParse(corps);
  if (!brut.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const e = brut.data;
  if ((TYPES_DE_FAITS as string[]).includes(e.event_type) && !Fait.safeParse(corps).success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const tenantId = e.subject_ref.consoleClientId;
  // Validé avant tout appel au dépôt (colonne uuid) : 400 constant, jamais un 500 que le Hub renverrait pendant 72 h.
  if (!tenantId || !FORME_UUID.test(tenantId)) throw new ErreurApi("schema_invalide", "Requête invalide.");
  if (!(await deps.depot.organisationExiste(tenantId))) throw new ErreurApi("introuvable", "Client inconnu.");
  const fait: FaitRange = { eventId: e.event_id, type: e.event_type, sequence: e.sequence, sujet: e.subject_ref.axiCli, payload: allegerPayload(e.payload) };
  // Le payload est rangé en base AVANT toute réponse 200 : si la file perd la tâche, le renvoi du Hub la refait depuis la base.
  const { neuf, traite, payload } = await deps.depot.ranger(tenantId, fait, deps.maintenant());
  // Déjà traité : 200 sans rien refaire. Déjà rangé mais pas traité : on remet la tâche avec le payload rangé (jamais celui du renvoi).
  if (!neuf && traite) return { statut: "deja_recu" };
  await deps.file.add(NOM_TACHE, { tenantId, eventId: e.event_id, sujet: fait.sujet, sequence: e.sequence, type: e.event_type, payload }, { jobId: idTache({ tenantId, type: NOM_TACHE, cle: e.event_id }) });
  await verifierTrous(deps, tenantId, fait.sujet, deps.maintenant());
  return { statut: neuf ? "range" : "deja_recu" };
}
