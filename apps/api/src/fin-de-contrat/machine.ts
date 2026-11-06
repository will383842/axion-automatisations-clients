import { ErreurApi } from "../plugins/erreurs.js";
import { exigerAucunGel, GelPourLitige } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import { etatPreuve } from "./preavis.js";
import { ErreurEtape, normaliser, type Verrou } from "../provisionnement/machine.js";

// Machine de la fin de contrat (A-250, A-254, A-255, C-035). L'état est celui du RÉEL (plans du Hub, base, export, préavis) : aucune colonne d'étape, donc aucune migration,
// et chaque étape se rejoue sans rien refaire. Règle C-715 : aucune étape ne supprime ni n'efface ; la dernière est l'attente de mise à l'écart (T2-45), et l'effacement
// n'est jamais lancé d'ici, seulement par un événement mis en file après un clic de Will.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ETAPES = ["clore_plans", "geler_base", "exporter", "preavis_j1", "preavis_j20", "preavis_j27", "attente_mise_a_l_ecart"] as const;
export type NomEtape = (typeof ETAPES)[number];
export type JourPreavis = 1 | 20 | 27;
export interface Preavis { envoyeLe: Date | null; accuse: string | null }
// Ce que la machine lit de fins_de_contrat (T2-30).
export interface Dossier { dateFin: string; exportReference: string | null; exportTelechargeLe: Date | null; preavis: Record<JourPreavis, Preavis> }
// Alerte de l'équipe : clé stable (type, client, code), l'adaptateur n'en crée qu'une tant qu'elle est ouverte.
export interface AlerteFin { type: string; clientId: string; code: string }
// Un préavis dont l'échéance est dépassée de plus que ce délai ne part plus : il lève une alerte (jamais trois préavis d'un coup après une panne ou une date erronée).
export const TOLERANCE_RETARD_MS = 48 * 3_600_000;
// Délai conseillé à l'ordonnanceur avant de rappeler la machine quand des réponses du Hub manquent encore.
export const REESSAI_REPONSES_MS = 15 * 60_000;
export interface EtapeFin {
  nom: string;
  // Décision explicite : seules les étapes qui RETIRENT ou ENVOIENT (préavis, export) sont suspendues par un gel pour litige (C-609).
  // Clore les plans du Hub et geler la base ne détruisent rien et ne doivent jamais attendre la levée d'un gel (la facturation s'arrêterait de ne pas s'arrêter).
  sousGel: boolean;
  // Instant avant lequel l'étape ne démarre pas. Toutes les étapes sont datées : minuit Europe/Paris de la date de fin (jour 0) ou de J+1, J+20, J+27.
  echeance: (d: Dossier) => Date;
  // Instant au-delà duquel l'étape, trop en retard, ne part plus et lève une alerte (préavis seulement).
  limite?: ((d: Dossier) => Date) | undefined;
  dejaFait(tenantId: string, d: Dossier): Promise<boolean>;
  faire(tenantId: string, d: Dossier): Promise<void>;
}

// Jours calendaires depuis la date de fin (AAAA-MM-JJ) : l'addition se fait sur le calendrier, jamais en multiples de 24 h.
export function ajouterJours(dateFin: string, jours: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateFin);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== dateFin) throw new Error("date de fin invalide");
  return new Date(t + jours * 86_400_000).toISOString().slice(0, 10);
}
const decalageParis = (t: Date): number => {
  const v = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  return Number(/GMT([+-]\d+)/.exec(v)?.[1] ?? 1) * 60;
};
// Minuit (Europe/Paris) du jour « date de fin + jours » : l'heure d'été ne décale jamais le jour.
export function echeance(dateFin: string, jours: number): Date {
  const [a, mo, j] = ajouterJours(dateFin, jours).split("-").map(Number) as [number, number, number];
  const minuitUtc = Date.UTC(a, mo - 1, j);
  for (const decalage of [60, 120]) {
    const t = new Date(minuitUtc - decalage * 60_000);
    if (decalageParis(t) === decalage) return t;
  }
  return new Date(minuitUtc - 3_600_000);
}

export function idTacheFin(tenantId: string, etape: NomEtape): string {
  const id = normaliser(tenantId);
  if (!UUID.test(id)) throw new Error("tenantId invalide");
  // BullMQ refuse « : » dans un identifiant personnalisé (et un identifiant entièrement numérique) : tirets seulement, préfixe lettre.
  return `fin-${id}-${etape}`;
}
const JOURS: readonly JourPreavis[] = [1, 20, 27];
// Une tâche par étape datée (jobId stable : la même tâche planifiée deux fois reste une) ; toutes appellent la même machine, qui avance aussi loin que possible.
// La clôture part à minuit Europe/Paris de la date de fin, ni avant ni après.
export function planifierTaches(tenantId: string, dateFin: string, maintenant: Date): { jobId: string; etape: NomEtape; delaiMs: number }[] {
  const tache = (etape: NomEtape, jours: number) => ({ jobId: idTacheFin(tenantId, etape), etape, delaiMs: Math.max(0, echeance(dateFin, jours).getTime() - maintenant.getTime()) });
  return [tache("clore_plans", 0), ...JOURS.map((j) => tache(`preavis_j${j}`, j))];
}

export type ResultatFin =
  | { etat: "a_jour"; etape: "attente_mise_a_l_ecart" }
  | { etat: "attend_date"; etape: string; jusqua: Date }
  | { etat: "attend_reponses"; etape: string; reessayerDansMs: number }
  | { etat: "suspendu_gel" | "en_retard"; etape: string }
  | { etat: "occupe" | "dossier_absent" };
export interface OptionsMachineFin {
  etapes: EtapeFin[];
  dossier(tenantId: string): Promise<Dossier | undefined>;
  gel: Pick<GelLitige, "gelActif">;
  alerter(a: AlerteFin): Promise<void>;
  // Verrou par client tenu pendant toute l'exécution (deux tâches de la même fin ne se chevauchent pas : ni second export, ni second préavis).
  verrou?: Verrou | undefined;
  maintenant(): Date;
}
export function creerMachineFin(o: OptionsMachineFin) {
  async function executerSousVerrou(tenantId: string): Promise<ResultatFin> {
    let enRetard: string | undefined;
    for (const etape of o.etapes) {
      // Relu à chaque étape : l'état réel a pu changer (réponse du Hub, préavis envoyé).
      const d = await o.dossier(tenantId);
      if (!d) return { etat: "dossier_absent" };
      if (await etape.dejaFait(tenantId, d)) continue;
      const quand = etape.echeance(d);
      if (o.maintenant() < quand) return { etat: "attend_date", etape: etape.nom, jusqua: quand };
      // Très en retard sur son échéance : alerte, rien ne part ; les étapes suivantes (encore à l'heure) continuent.
      const limite = etape.limite?.(d);
      if (limite && o.maintenant() > limite) {
        await o.alerter({ type: "fin_de_contrat", clientId: tenantId, code: `${etape.nom}_en_retard` });
        enRetard ??= etape.nom;
        continue;
      }
      try {
        // Un gel pour litige suspend les envois et les retraits, jamais la clôture des plans ni le gel de la base (C-609) ; l'étape le relit elle-même juste avant d'agir.
        if (etape.sousGel) await exigerAucunGel(o.gel, tenantId, "preavis");
        await etape.faire(tenantId, d);
      } catch (e) {
        if (e instanceof GelPourLitige) return { etat: "suspendu_gel", etape: etape.nom };
        throw e instanceof ErreurEtape ? e : new ErreurEtape("erreur_inattendue");
      }
      // L'étape suivante ne démarre que si celle-ci est FAITE (toutes les réponses du Hub reçues pour la clôture).
      const apres = await o.dossier(tenantId);
      if (!apres || !(await etape.dejaFait(tenantId, apres))) return { etat: "attend_reponses", etape: etape.nom, reessayerDansMs: REESSAI_REPONSES_MS };
    }
    // Envoyé sans accusé n'est pas prouvé : un préavis sans accusé lève une alerte (clé stable par préavis), il ne compte jamais comme preuve (dette T2-44).
    const fin = enRetard ? undefined : await o.dossier(tenantId);
    for (const jour of JOURS) if (fin && etatPreuve(fin.preavis[jour]) !== "prouve") await o.alerter({ type: "fin_de_contrat", clientId: tenantId, code: `preavis_j${jour}_sans_accuse` });
    return enRetard ? { etat: "en_retard", etape: enRetard } : { etat: "a_jour", etape: "attente_mise_a_l_ecart" };
  }
  return {
    async executer(brut: string): Promise<ResultatFin> {
      const tenantId = normaliser(brut);
      if (!UUID.test(tenantId)) throw new Error("tenantId invalide");
      const rendre = o.verrou ? await o.verrou.prendre(tenantId) : async () => undefined;
      if (!rendre) return { etat: "occupe" };
      try {
        return await executerSousVerrou(tenantId);
      } finally {
        await rendre();
      }
    },
  };
}

// Demande écrite d'effacement (A-253, C-623) : une demande en attente et une alerte pour Will. Elle ne touche ni le dossier ni aucune date ; la décision est en T2-45.
export async function recevoirDemandeEffacement(o: { creer(tenantId: string, ecritReference: string): Promise<{ id: string }>; alerter(a: AlerteFin): Promise<void> }, tenantId: string, ecritReference: string): Promise<{ id: string }> {
  const ref = typeof ecritReference === "string" ? ecritReference.trim() : "";
  if (ref === "" || ref.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const demande = await o.creer(tenantId, ref);
  await o.alerter({ type: "demande_effacement", clientId: tenantId, code: "decision_de_will_attendue" });
  return demande;
}
