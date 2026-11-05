import type { Journal } from "./journal.js";
import type { RegistreJetons } from "./jetons.js";

// Remise (T4-39) : pour UNE exécution d'UN client, le jeton d'accès du fournisseur ou un jeton court pour le mandataire.
// Jamais le jeton de renouvellement (A-334), jamais un mot de passe d'application. La valeur n'est ni gardée ni journalisée (A-337).
// La signature de la cellule et le jeton d'instance sont vérifiés par l'API (le courtier ne lit pas technique/) : ports en entrée.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARGE_MS = 60_000;
const DUREE_RESTANTE_MIN_MS = 30_000; // un jeton fournisseur plus court est refusé : il expirerait avant usage
const CLES = ["connexionId", "executionId", "instanceId"];

// Planifie une échéance et rend son annulation ; remplaçable par une horloge factice dans les essais.
export type Planifier = (f: () => void, ms: number) => () => void;
export const planifierReel: Planifier = (f, ms) => { const t = setTimeout(f, ms); return () => clearTimeout(t); };
export const DELAI_PAR_DEFAUT_MS = 5000;

// Course entre un appel de port et son échéance : à l'échéance, `signal` est annulé (l'appel en vol est abandonné)
// et l'erreur est propre, sans rien de ce que le port aurait pu dire.
export async function avecDelai<T>(appel: (signal: AbortSignal) => Promise<T>, ms: number, planifier: Planifier): Promise<T> {
  const controle = new AbortController();
  let annuler = () => undefined as void;
  const echeance = new Promise<never>((_, ko) => { annuler = planifier(() => { controle.abort(); ko(new Error("delai")); }, ms); });
  try {
    return await Promise.race([appel(controle.signal), echeance]);
  } finally {
    annuler();
  }
}

export class ErreurRemise extends Error {
  constructor(readonly code: "demande_invalide" | "refusee" | "deja_remise" | "coffre_indisponible" | "valeur_invalide" | "famille_non_geree") {
    super(code);
    this.name = "ErreurRemise";
  }
}

export interface Connexion {
  instanceId: string; // le couple (instanceId, connexionId) est revérifié par le courtier
  connexionId: string;
  tenantId: string;
  celluleCode: string | null;
  famille: "oauth" | "messagerie" | "base";
  referenceCoffre: string;
  portees: readonly string[]; // accordées à la connexion
  porteesModule: readonly string[]; // déclarées par le module de l'instance ; le jeton porte l'intersection
}
export interface PortsRemise {
  // Demande à l'API de vérifier le jeton d'instance (clé ji) : le courtier ne lit jamais echanges/ji.
  verifierJetonInstance(jeton: string, portee: { instanceId: string; cellule: string }): Promise<boolean>;
  // Lecture de la table connexions sous RLS ; tenantId vient de la base, jamais de la demande.
  connexion(instanceId: string, connexionId: string): Promise<Connexion | undefined>;
  // Contrat : vrai seulement si l'exécution existe, est EN COURS, et appartient à cette instance et à cette cellule
  // (table executions sous RLS ou exécution signée par l'API). Inconnue, terminée, autre instance ou panne : faux.
  executionEnCours(e: { executionId: string; instanceId: string; cellule: string }): Promise<boolean>;
  // `signal` est annulé à l'échéance : le port abandonne l'appel au coffre.
  lireCoffre(chemin: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  planifier?: Planifier; // horloge des délais (réelle par défaut)
  delaiCoffreMs?: number; // délai maximal d'une lecture du coffre (5 s par défaut)
  jetons: RegistreJetons;
  journal: Journal;
  maintenant(): number;
  dureeExecutionMs: number;
}
export type Remise = { type: "oauth"; jetonAcces: string; expire: string } | { type: "mandataire"; jeton: string; expire: string };

function lireDemande(brut: unknown): { instanceId: string; executionId: string; connexionId: string } {
  if (typeof brut !== "object" || brut === null || Array.isArray(brut) || Object.keys(brut).sort().join() !== CLES.join()) throw new ErreurRemise("demande_invalide");
  const d = brut as Record<string, unknown>;
  for (const k of CLES) if (typeof d[k] !== "string" || !UUID.test(d[k] as string)) throw new ErreurRemise("demande_invalide");
  return { instanceId: d["instanceId"] as string, executionId: d["executionId"] as string, connexionId: d["connexionId"] as string };
}

// bao:clients/<tenant>/<reste> -> clients/data/<tenant>/<reste> ; tout autre chemin ou tenant est refusé.
function cheminDeLaReference(reference: string, tenantId: string): string | null {
  const m = /^bao:clients\/([0-9a-f-]{36})\/([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/.exec(reference);
  return m && m[1] === tenantId ? `clients/data/${tenantId}/${m[2]}` : null;
}

export async function remettre(p: PortsRemise, appelant: { cellule: string; jetonInstance: string }, brut: unknown): Promise<Remise> {
  const d = lireDemande(brut);
  const base = { cellule: appelant.cellule, instanceId: d.instanceId, executionId: d.executionId, connexionId: d.connexionId };
  const refuser = (code: ErreurRemise["code"], extra: { tenantId?: string; famille?: string } = {}): never => {
    p.journal.tracer({ evenement: "remise_refusee", ...base, ...extra, code });
    throw new ErreurRemise(code);
  };
  if (!appelant.jetonInstance) return refuser("refusee");
  // Même code pour jeton refusé, instance inconnue, autre cellule ou référence hors du client : aucune raison donnée.
  if (!(await p.verifierJetonInstance(appelant.jetonInstance, { instanceId: d.instanceId, cellule: appelant.cellule }).catch(() => false))) return refuser("refusee");
  const c = await p.connexion(d.instanceId, d.connexionId).catch(() => undefined);
  if (!c || c.celluleCode !== appelant.cellule || !UUID.test(c.tenantId) || c.instanceId !== d.instanceId || c.connexionId !== d.connexionId) return refuser("refusee");
  const chemin = cheminDeLaReference(c.referenceCoffre, c.tenantId);
  if (!chemin) return refuser("refusee", { tenantId: c.tenantId });
  if (c.famille === "base") return refuser("famille_non_geree", { tenantId: c.tenantId, famille: c.famille });
  // L'exécution doit exister, être en cours et appartenir à cette instance et cette cellule, AVANT toute réservation ou lecture du coffre.
  if (!(await p.executionEnCours({ executionId: d.executionId, instanceId: d.instanceId, cellule: appelant.cellule }).catch(() => false))) return refuser("refusee", { tenantId: c.tenantId });
  const duree = p.dureeExecutionMs + MARGE_MS;
  if (!(await p.jetons.reserver(d.executionId, d.connexionId))) return refuser("deja_remise", { tenantId: c.tenantId });

  // Messagerie : le mot de passe reste dans le coffre, c'est le mandataire qui le lit ; le courtier ne le lit pas.
  let valeur: Record<string, unknown> = {};
  try {
    if (c.famille === "oauth") valeur = await avecDelai((signal) => p.lireCoffre(chemin, signal), p.delaiCoffreMs ?? DELAI_PAR_DEFAUT_MS, p.planifier ?? planifierReel);
  } catch {
    await p.jetons.liberer(d.executionId, d.connexionId);
    return refuser("coffre_indisponible", { tenantId: c.tenantId }); // le message d'origine est écarté : il pourrait contenir la valeur
  }
  const fin = p.maintenant() + duree;
  let remise: Remise;
  if (c.famille === "oauth") {
    const acces = valeur["access_token"];
    const expireFournisseur = valeur["expires_at"];
    if (typeof acces !== "string" || acces === "" || typeof expireFournisseur !== "number" || expireFournisseur * 1000 - p.maintenant() < DUREE_RESTANTE_MIN_MS) {
      await p.jetons.liberer(d.executionId, d.connexionId);
      return refuser("valeur_invalide", { tenantId: c.tenantId });
    }
    remise = { type: "oauth", jetonAcces: acces, expire: new Date(Math.min(fin, expireFournisseur * 1000)).toISOString() };
  } else {
    const { jeton, expire } = p.jetons.emettre({ tenantId: c.tenantId, instanceId: d.instanceId, connexionId: d.connexionId, executionId: d.executionId, portees: c.portees.filter((x) => c.porteesModule.includes(x)) }, duree);
    remise = { type: "mandataire", jeton, expire: expire.toISOString() };
  }
  p.journal.tracer({ evenement: "remise", ...base, tenantId: c.tenantId, famille: c.famille });
  return remise;
}
