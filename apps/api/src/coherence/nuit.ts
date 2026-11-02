import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { avecClient, avecEquipe } from "../db/client-actif.js";
import { fermerPerimeesSql } from "./appliquer.js";
import { maitreDe, type Systeme, type TypeInformation } from "./maitres.js";

// Contrôle de cohérence de nuit (C-364) : compare les trois listes (console, Hub, CRM) et RANGE des propositions dans « à trancher ».
// Il ne corrige jamais seul (C-365) : l'application passe par appliquer.ts, sur un clic de l'équipe.
// Les lectures du Hub (C1) et du CRM (C3) sont des ports : leurs clients signés viennent de T2-15 et T2-17 (non fusionnées).

export type StatutConsole = "prospect" | "en_signature" | "client" | "ancien_client";
export type StatutC1 = "prospect" | "client_actif" | "ancien_client";
// « en_signature » est interne à la console : C1 et C3 la voient comme « prospect ».
const VERS_C1: Record<StatutConsole, StatutC1> = { prospect: "prospect", en_signature: "prospect", client: "client_actif", ancien_client: "ancien_client" };

export interface OrganisationConsole { tenantId: string; siren: string | null; statut: StatutConsole; crmCompanyId: string | null }
export interface FicheHub { axiCli: string; consoleClientId: string | null; siren: string | null; statut: StatutC1 }
export interface FicheCrm { crmCompanyId: string; siren: string | null; consoleClientId: string | null; absorbeePar?: string }
export interface NumeroPorte { tenantId: string; numero: string; nature: "devis" | "facture" }
export interface EntreeComparaison { organisations: OrganisationConsole[]; hub: FicheHub[]; crm: FicheCrm[]; numeros: NumeroPorte[] }

export type TypeEcart = "absent_hub" | "absent_console" | "absent_crm" | "double_crm" | "double_hub" | "statut_diverge" | "fiche_absorbee" | "numero_en_double" | "sans_siren";
export interface Proposition { action: string; cible: Systeme; avant: Record<string, string | null>; apres: Record<string, string | null> }
export interface Ecart {
  type: TypeEcart;
  information: TypeInformation;
  maitre: Systeme;
  // Clé anti-doublon : type + identifiants + valeur proposée (un écart déjà ouvert n'est pas recréé ; si la valeur proposée change, la clé change
  // et l'ancienne ligne est fermée par la nuit). Une clé ne cite jamais un autre client que celui de sa ligne.
  cle: string;
  // Clients de la console concernés (une ligne « à trancher » par client) ; vide : aucun client de la console, l'écart reste au rapport.
  tenantIds: string[];
  source: "hub" | "crm";
  proposition: Proposition;
}

const A_EXAMINER = (cible: Systeme): Proposition => ({ action: "a_examiner", cible, avant: {}, apres: {} });
function ecart(type: TypeEcart, information: TypeInformation, source: "hub" | "crm", ids: string[], tenantIds: string[], proposition: Proposition): Ecart {
  return { type, information, maitre: maitreDe(information), cle: `${type}:${[...ids].sort().join("+")}`, tenantIds: [...tenantIds].sort(), source, proposition };
}
function grouper<T>(items: T[], cle: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) { const k = cle(i); if (k !== null) m.set(k, [...(m.get(k) ?? []), i]); }
  return m;
}

export function comparer(e: EntreeComparaison): Ecart[] {
  const sortie: Ecart[] = [];
  const parTenant = new Map(e.organisations.map((o) => [o.tenantId, o]));
  const orgDeSiren = grouper(e.organisations, (o) => o.siren);
  const tenantsDe = (siren: string | null, direct?: string | null): string[] => [...new Set([...(direct && parTenant.has(direct) ? [direct] : []), ...(siren ? (orgDeSiren.get(siren) ?? []).map((o) => o.tenantId) : [])])];

  // Présent deux fois : plusieurs fiches pour un même SIREN (CRM, puis Hub).
  for (const [siren, fiches] of grouper(e.crm.filter((f) => !f.absorbeePar), (f) => f.siren)) {
    // La fiche gardée n'est pas choisie ici (aucune fusion sans choix explicite de l'équipe) : gardee reste null. Dette : voir appliquer.ts (T2-14).
    if (fiches.length > 1) sortie.push(ecart("double_crm", "prospect", "crm", [siren, ...fiches.map((f) => f.crmCompanyId)], tenantsDe(siren), { action: "demander_fusion_crm", cible: "crm", avant: { fiches: fiches.map((f) => f.crmCompanyId).sort().join(",") }, apres: { gardee: null } }));
  }
  for (const [siren, fiches] of grouper(e.hub, (f) => f.siren)) {
    if (fiches.length > 1) sortie.push(ecart("double_hub", "statut_client", "hub", [siren, ...fiches.map((f) => f.axiCli)], tenantsDe(siren), A_EXAMINER("hub")));
  }

  const hubDe = (o: OrganisationConsole): FicheHub | undefined => e.hub.find((h) => h.consoleClientId === o.tenantId) ?? (o.siren ? e.hub.find((h) => h.consoleClientId === null && h.siren === o.siren) : undefined);
  const crmDe = (o: OrganisationConsole): FicheCrm | undefined => e.crm.find((c) => c.consoleClientId === o.tenantId || (o.crmCompanyId !== null && c.crmCompanyId === o.crmCompanyId)) ?? (o.siren ? e.crm.find((c) => c.consoleClientId === null && !c.absorbeePar && c.siren === o.siren) : undefined);

  for (const o of e.organisations) {
    const h = hubDe(o);
    const c = crmDe(o);
    if (!o.siren && !h && !c) {
      // C-456 : sans SIREN et sans identifiant croisé, la nuit ne crée rien d'aucun côté.
      sortie.push(ecart("sans_siren", "statut_client", "crm", [o.tenantId], [o.tenantId], A_EXAMINER("console")));
      continue;
    }
    if (!h && o.statut !== "prospect" && o.siren) sortie.push(ecart("absent_hub", "statut_client", "hub", [o.tenantId], [o.tenantId], { action: "creer_fiche_hub", cible: "hub", avant: {}, apres: { siren: o.siren, statut: VERS_C1[o.statut] } }));
    if (!h && o.statut !== "prospect" && !o.siren) sortie.push(ecart("sans_siren", "statut_client", "hub", [o.tenantId], [o.tenantId], A_EXAMINER("console")));
    if (!c && o.siren) sortie.push(ecart("absent_crm", "prospect", "crm", [o.tenantId], [o.tenantId], { action: "creer_fiche_crm", cible: "crm", avant: {}, apres: { siren: o.siren } }));
    // C-095 : le statut du client vient de la console ; la correction vise toujours le Hub.
    if (h && h.statut !== VERS_C1[o.statut]) sortie.push(ecart("statut_diverge", "statut_client", "hub", [o.tenantId, h.axiCli, VERS_C1[o.statut]], [o.tenantId], { action: "aligner_statut_hub", cible: "hub", avant: { statut: h.statut }, apres: { statut: VERS_C1[o.statut] } }));
    const lie = o.crmCompanyId ? e.crm.find((f) => f.crmCompanyId === o.crmCompanyId) : undefined;
    if (lie?.absorbeePar) sortie.push(ecart("fiche_absorbee", "prospect", "crm", [o.tenantId, lie.crmCompanyId], [o.tenantId], { action: "relier_fiche_gardee", cible: "console", avant: { crmCompanyId: lie.crmCompanyId }, apres: { crmCompanyId: lie.absorbeePar } }));
  }

  // Fiche du Hub ou du CRM sans client dans la console : jamais créée par la nuit (C-456), mise au rapport.
  for (const h of e.hub) {
    const connue = (h.consoleClientId !== null && parTenant.has(h.consoleClientId)) || (h.siren !== null && orgDeSiren.has(h.siren));
    if (!connue) sortie.push(ecart("absent_console", "statut_client", "hub", [h.axiCli], [], A_EXAMINER("console")));
  }

  // ADR 0040 : un numéro de devis ou de facture n'est plus unique globalement ; deux clients ne doivent pourtant pas le porter.
  // Une ligne par client sous son propre tenantId, avec une clé propre « nature:numéro » : la ligne d'un client ne cite jamais l'autre.
  for (const [k, lignes] of grouper(e.numeros, (n) => `${n.nature}:${n.numero}`)) {
    const tenants = [...new Set(lignes.map((l) => l.tenantId))].sort();
    if (tenants.length < 2) continue;
    for (const t of tenants) sortie.push(ecart("numero_en_double", lignes[0]!.nature === "devis" ? "devis" : "factures", "hub", [k], [t], { action: "a_examiner", cible: "console", avant: { numero: lignes[0]!.numero }, apres: {} }));
  }
  return sortie;
}

export interface LigneACreer { source: "hub" | "crm"; motif: "incoherence_nuit"; donneesComparaison: { cle: string; type: TypeEcart; proposition: Proposition } }
export interface Ecrivain {
  ouvertes(tenantId: string): Promise<Set<string>>;
  // Ferme (decision « resolu:nuit ») les lignes ouvertes de la nuit dont la clé n'est plus produite ; rend leur nombre.
  fermerPerimees(tenantId: string, clesProduites: Set<string>): Promise<number>;
  inserer(tenantId: string, ligne: LigneACreer): Promise<void>;
}
export interface RapportNuit { crees: number; dejaOuverts: number; fermees: number; sansClient: Ecart[] }

// Anti-doublon : la lecture des lignes ouvertes puis l'insertion ne sont pas atomiques ; deux nuits lancées en parallèle pourraient créer deux fois la même ligne.
// Dette : aucun index unique partiel n'existe sur a_trancher. Migration future, propriétaire : T2-52 (fiche ouverte). Elle ajoute un index unique partiel
// (tenant_id, donnees_comparaison->>'cle') WHERE motif = 'incoherence_nuit' AND etat = 'ouvert', puis cette écriture passe en INSERT ... ON CONFLICT DO NOTHING.
// Critère : un essai d'intégration lance deux nuits en parallèle sur la même entrée et trouve une seule ligne ouverte par clé.
// Ligne écartée (état tranché) : elle n'est pas « ouverte », donc un écart qui persiste est recréé chaque nuit. Choix voulu : une incohérence non réglée reste
// visible, la nuit ne la tait pas. Une mise en sommeil demanderait une colonne : T2-52, critère : un écart écarté avec motif ne revient pas avant la date choisie.
// Rattrapage : la comparaison est rejouable sans effet de bord (les lignes déjà créées sont vues comme ouvertes) ; une nuit interrompue est donc reprise
// par la nouvelle tentative de la tâche (3 essais, attente croissante) ou, à défaut, par la nuit suivante.
export async function lancerNuit(d: { lire: () => Promise<EntreeComparaison>; ecrivain: Ecrivain }): Promise<RapportNuit> {
  const rapport: RapportNuit = { crees: 0, dejaOuverts: 0, fermees: 0, sansClient: [] };
  const entree = await d.lire();
  const parTenant = new Map<string, Ecart[]>(entree.organisations.map((o) => [o.tenantId, []]));
  for (const x of comparer(entree)) {
    if (x.tenantIds.length === 0) { rapport.sansClient.push(x); continue; }
    for (const t of x.tenantIds) parTenant.set(t, [...(parTenant.get(t) ?? []), x]);
  }
  for (const [t, ecarts] of parTenant) {
    // Une ligne ouverte dont la clé n'est plus produite est périmée (écart disparu ou valeur proposée changée) : fermée avant toute création.
    rapport.fermees += await d.ecrivain.fermerPerimees(t, new Set(ecarts.map((x) => x.cle)));
    const ouvertes = await d.ecrivain.ouvertes(t);
    for (const x of ecarts) {
      if (ouvertes.has(x.cle)) { rapport.dejaOuverts += 1; continue; }
      await d.ecrivain.inserer(t, { source: x.source, motif: "incoherence_nuit", donneesComparaison: { cle: x.cle, type: x.type, proposition: x.proposition } });
      ouvertes.add(x.cle);
      rapport.crees += 1;
    }
  }
  return rapport;
}

// Tâche BullMQ de nuit : l'identifiant est la date, relancer le même jour ne crée pas une seconde tâche.
// Trois essais, attente croissante (60 s, puis 120 s) : une panne passagère du Hub ou du CRM ne fait pas perdre la nuit.
export interface OptionsNuit { jobId: string; attempts: number; backoff: { type: "exponential"; delay: number } }
export async function planifierNuit(file: { add(nom: string, donnees: { date: string }, opts: OptionsNuit): Promise<unknown> }, date: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date invalide (AAAA-MM-JJ)");
  await file.add("coherence-nuit", { date }, { jobId: date, attempts: 3, backoff: { type: "exponential", delay: 60_000 } });
}

// Lecture de la console : équipe, transaction en lecture seule.
export async function lireConsole(poolEquipe: Pool): Promise<Pick<EntreeComparaison, "organisations" | "numeros">> {
  return avecEquipe(poolEquipe, async (c) => {
    const o = await c.query("SELECT tenant_id, siren, statut, crm_company_id FROM organisations");
    const n = await c.query("SELECT tenant_id, numero_hub AS numero, 'devis' AS nature FROM devis UNION ALL SELECT tenant_id, numero, 'facture' AS nature FROM factures");
    return {
      organisations: o.rows.map((r) => ({ tenantId: r.tenant_id, siren: r.siren, statut: r.statut, crmCompanyId: r.crm_company_id })),
      numeros: n.rows.map((r) => ({ tenantId: r.tenant_id, numero: r.numero, nature: r.nature })),
    };
  });
}

// Seule écriture du dossier hors appliquer.ts : une ligne « à trancher ». Jamais de texte de message : métadonnées seulement.
export function ecrivainSql(pool: Pool, acteur = "controle-nuit"): Ecrivain {
  return {
    async ouvertes(tenantId) {
      return avecClient(pool, tenantId, async (c) => new Set((await c.query("SELECT donnees_comparaison->>'cle' AS cle FROM a_trancher WHERE motif = 'incoherence_nuit' AND etat = 'ouvert'")).rows.map((r) => String(r.cle))));
    },
    async fermerPerimees(tenantId, produites) {
      return avecClient(pool, tenantId, (c) => fermerPerimeesSql(c, acteur, [...produites]), { acteur });
    },
    async inserer(tenantId, l) {
      await avecClient(pool, tenantId, async (c) => {
        await c.query("INSERT INTO a_trancher (tenant_id, id, organisation_id, source, motif, donnees_comparaison) VALUES ($1, $2, $1, $3, 'incoherence_nuit', $4::jsonb)", [tenantId, randomUUID(), l.source, JSON.stringify(l.donneesComparaison)]);
      }, { acteur });
    },
  };
}
