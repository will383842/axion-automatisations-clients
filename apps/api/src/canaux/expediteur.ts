import { randomUUID } from "node:crypto";
import type { CodeErreur } from "../../../../packages/contrats/src/commun/erreurs.js";
import { CONSERVATION_IDEMPOTENCE_JOURS, horodatageSuivant } from "../../../../packages/contrats/src/commun/signature.js";
import { verifierAppelant, type Appelant } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { Canal } from "./journal-canal.js";

// Expéditeur (A-091, C-403, C-535) : un essai = relire la ligne, re-signer (nouvel horodatage, MÊME Idempotency-Key), envoyer, ranger.
// La base est la source de vérité : les nouveaux essais sont programmés par `prochain_essai` et redéposés par le relais.
export type Destination = "hub" | "crm";
export interface Ref { tenantId: string; id: string }
export interface LigneEnvoi extends Ref {
  destination: Destination;
  route: string;
  methode: "POST" | "PUT" | "PATCH" | "DELETE";
  corps: unknown;
  cle: string;
  etat: "a_envoyer" | "en_cours" | "envoye" | "echec";
  nombreEssais: number;
  derniereErreur?: string;
  reponse?: unknown;
  prochainEssai?: Date;
  creeLe: Date;
  priseLe?: Date;
}
export interface EchecEnvoi extends Ref { destination: Destination; route: string; nombreEssais: number; derniereErreur: string | null; creeLe: Date }
export interface Magasin {
  // Passe la ligne à « en_cours » et compte l'essai ; null si elle est déjà envoyée, en échec ou absente.
  // Jamais au-delà de `max` essais, et jamais avant `prochain_essai` pour une ligne reportée.
  prendre(r: Ref, maintenant: Date, max?: number): Promise<LigneEnvoi | null>;
  conclure(r: Ref, c: { etat: "envoye" | "echec"; erreur?: string; reponse?: unknown }): Promise<void>;
  // Nouvel essai plus tard ; compter = false quand l'essai n'a pas eu lieu (canal fermé).
  reporter(r: Ref, c: { prochainEssai: Date; erreur: string; compter: boolean }): Promise<void>;
  dues(destination: Destination, maintenant: Date, limite: number): Promise<(Ref & { cle: string })[]>;
  reprendre(avant: Date): Promise<number>;
  echecs(): Promise<EchecEnvoi[]>;
  // Renvoi par un humain : l'acteur est obligatoire et inscrit au journal d'audit (action, ligne, acteur) dans la même transaction.
  // Une ligne créée il y a plus de CONSERVATION_IDEMPOTENCE_JOURS jours est refusée (le Hub a oublié la clé : un second envoi créerait un doublon) sauf confirmation explicite.
  renvoyer(r: Ref, appelant: Appelant, options?: { confirmerAnciennete?: boolean }): Promise<boolean>;
}
export const MESSAGE_TROP_ANCIENNE = `Ligne créée il y a plus de ${CONSERVATION_IDEMPOTENCE_JOURS} jours : le Hub a oublié la clé, un renvoi peut créer un doublon. Confirmation explicite requise.`;
export interface AlerteEnvoi { type: "cle_reutilisee" | "envoi_en_echec"; destination: Destination; cle: string }
export interface Signeur { signerRequete(canal: Canal, methode: string, chemin: string, corps: string, maintenant: number): Promise<Record<string, string>> }
export type Verdict = "envoye" | "reessai" | "echec" | "ferme" | "ignore";
export interface DepsExpediteur {
  magasin: Magasin;
  signeur: Signeur;
  urls: Record<Destination, string>;
  alerter: (a: AlerteEnvoi) => Promise<void> | void;
  maintenant?: () => number;
  aleatoire?: () => number;
  fetch?: typeof fetch;
  essaisMax?: number;
}

export const ESSAIS_MAX = 5;
const CANAL: Record<Destination, Canal> = { hub: "c1", crm: "c3" };
const DELAI_MS = 10_000;
const ATTENTE_FERME_MS = 30_000;
const PLAFOND_MS = 300_000;
// Une réponse 4xx est définitive (jamais un nouvel essai), sauf celles qu'un autre essai peut changer : clé de signature en rotation, rejeu, horloge, débit.
const PASSAGERES = new Set<CodeErreur>(["rejeu", "signature_invalide", "horodatage_perime", "debit_depasse", "porte_fermee"]);
const ATTENTE_MIN_MS = 1000;
// Réponse du Hub rangée en jsonb : au-delà, seule la marque de dépassement est gardée (jamais un texte tronqué en JSON invalide).
export const REPONSE_MAX_OCTETS = 65_536;
const MAX_HORODATAGES = 10_000;
async function lireBornee(r: Response): Promise<unknown> {
  const lecteur = r.body?.getReader();
  if (!lecteur) return null;
  const morceaux: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.byteLength;
    if (total > REPONSE_MAX_OCTETS) {
      await lecteur.cancel().catch(() => undefined);
      return { reponse_trop_grande: true };
    }
    morceaux.push(value);
  }
  try { return JSON.parse(Buffer.concat(morceaux).toString("utf8")); } catch { return null; }
}
const code = (v: unknown): string => {
  const c = (v as { erreur?: { code?: unknown } } | null)?.erreur?.code;
  return typeof c === "string" && /^[a-z0-9_.-]{1,64}$/.test(c) ? c : "reponse_inattendue";
};

export function creerExpediteur(d: DepsExpediteur) {
  const maintenant = d.maintenant ?? Date.now;
  const aleatoire = d.aleatoire ?? Math.random;
  const max = d.essaisMax ?? ESSAIS_MAX;
  // Dernier horodatage signé par ligne : un deuxième essai dans la même seconde ne reprend pas la même signature (le Hub la prendrait pour un rejeu, 401).
  const horodatages = new Map<string, string>();
  // Attente croissante avec aléa ; Retry-After (secondes) fait loi s'il est plus long.
  const attente = (essais: number, retryApres?: number) => Math.max(ATTENTE_MIN_MS, Math.round(Math.min(1000 * 2 ** (essais - 1), PLAFOND_MS) * (0.5 + aleatoire() / 2)), Math.min(retryApres ?? 0, 3600) * 1000);

  async function concluEnEchec(ref: Ref, ligne: LigneEnvoi, erreur: string): Promise<Verdict> {
    await d.magasin.conclure(ref, { etat: "echec", erreur });
    await d.alerter({ type: "envoi_en_echec", destination: ligne.destination, cle: ligne.cle });
    return "echec";
  }

  return {
    async executer(ref: Ref): Promise<Verdict> {
      const ligne = await d.magasin.prendre(ref, new Date(maintenant()), max);
      if (!ligne) return "ignore";
      const corps = JSON.stringify(ligne.corps);
      let headers: Record<string, string>;
      const horodatage = Number(horodatageSuivant(horodatages.get(ligne.id), maintenant() / 1000));
      try {
        headers = await d.signeur.signerRequete(CANAL[ligne.destination], ligne.methode, ligne.route, corps, horodatage);
      } catch (e) {
        if (e instanceof ErreurApi && e.code === "porte_fermee") {
          await d.magasin.reporter(ref, { prochainEssai: new Date(maintenant() + ATTENTE_FERME_MS), erreur: "porte_fermee", compter: false });
          return "ferme";
        }
        // Coffre indisponible, clé absente… : l'essai compte, sinon la ligne bouclerait sans fin (C-403). Seul un code est rangé, jamais le message.
        if (ligne.nombreEssais >= max) return concluEnEchec(ref, ligne, "essais_epuises");
        await d.magasin.reporter(ref, { prochainEssai: new Date(maintenant() + attente(ligne.nombreEssais)), erreur: "signature_impossible", compter: true });
        return "reessai";
      }
      // Noté dès la signature : une coupure réseau pendant l'envoi ne doit pas faire reprendre le même horodatage.
      horodatages.delete(ligne.id);
      horodatages.set(ligne.id, String(horodatage));
      if (horodatages.size > MAX_HORODATAGES) horodatages.delete(horodatages.keys().next().value as string);
      let statut = 0;
      let retryApres: number | undefined;
      let reponse: unknown;
      try {
        const r = await (d.fetch ?? fetch)(`${d.urls[ligne.destination]}${ligne.route}`, {
          method: ligne.methode,
          headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": ligne.cle },
          body: corps,
          signal: AbortSignal.timeout(DELAI_MS),
        });
        statut = r.status;
        const ra = Number(r.headers.get("retry-after"));
        retryApres = Number.isFinite(ra) && ra > 0 ? ra : undefined;
        reponse = await lireBornee(r).catch(() => null);
      } catch {
        statut = 0; // coupure réseau ou délai dépassé
      }
      if (statut >= 200 && statut < 300) {
        horodatages.delete(ligne.id);
        await d.magasin.conclure(ref, { etat: "envoye", reponse });
        return "envoye";
      }
      const motif = statut === 0 ? "reseau" : code(reponse);
      if (statut === 409 && motif === "cle_reutilisee") {
        // Défaut du producteur (même clé, autre corps) : jamais un nouvel essai.
        await d.magasin.conclure(ref, { etat: "echec", erreur: motif });
        await d.alerter({ type: "cle_reutilisee", destination: ligne.destination, cle: ligne.cle });
        return "echec";
      }
      const definitif = statut >= 400 && statut < 500 && statut !== 408 && statut !== 429 && !PASSAGERES.has(motif as CodeErreur);
      if (definitif || ligne.nombreEssais >= max) return concluEnEchec(ref, ligne, motif);
      await d.magasin.reporter(ref, { prochainEssai: new Date(maintenant() + attente(ligne.nombreEssais, retryApres)), erreur: motif, compter: true });
      return "reessai";
    },
  };
}

// Magasin en mémoire (essais) : mêmes règles que la base.
export function magasinEnMemoire(maintenant: () => number = Date.now): Magasin & { deposer(l: Pick<LigneEnvoi, "tenantId" | "destination" | "route" | "methode" | "corps" | "cle"> & { creeLe?: Date }): Ref; lignes(): LigneEnvoi[]; journal: { action: string; ligne: string; acteur: string }[] } {
  const tout: LigneEnvoi[] = [];
  const journal: { action: string; ligne: string; acteur: string }[] = [];
  const trouver = (r: Ref) => tout.find((l) => l.id === r.id && l.tenantId === r.tenantId);
  return {
    deposer(l) {
      const ligne: LigneEnvoi = { ...l, id: randomUUID(), etat: "a_envoyer", nombreEssais: 0, creeLe: l.creeLe ?? new Date(maintenant()) };
      tout.push(ligne);
      return { tenantId: ligne.tenantId, id: ligne.id };
    },
    lignes: () => tout,
    journal,
    async prendre(r, maintenant, max = ESSAIS_MAX) {
      const l = trouver(r);
      if (!l || (l.etat !== "a_envoyer" && l.etat !== "en_cours") || l.nombreEssais >= max) return null;
      if (l.etat === "a_envoyer" && l.prochainEssai && l.prochainEssai > maintenant) return null;
      // Deux travailleurs sur la même ligne : un seul la prend (la base le fait par UPDATE conditionnel).
      if (l.etat === "en_cours" && l.priseLe && maintenant.getTime() - l.priseLe.getTime() < 120_000) return null;
      l.etat = "en_cours";
      l.nombreEssais++;
      l.priseLe = maintenant;
      return { ...l };
    },
    async conclure(r, c) {
      const l = trouver(r);
      if (!l) return;
      l.etat = c.etat;
      if (c.erreur) l.derniereErreur = c.erreur;
      if (c.reponse !== undefined) l.reponse = c.reponse;
    },
    async reporter(r, c) {
      const l = trouver(r);
      if (!l) return;
      l.etat = "a_envoyer";
      l.derniereErreur = c.erreur;
      l.prochainEssai = c.prochainEssai;
      if (!c.compter) l.nombreEssais--;
    },
    async dues(destination, maintenant, limite) {
      return tout.filter((l) => l.destination === destination && l.etat === "a_envoyer" && (!l.prochainEssai || l.prochainEssai <= maintenant)).sort((a, b) => a.creeLe.getTime() - b.creeLe.getTime()).slice(0, limite).map((l) => ({ tenantId: l.tenantId, id: l.id, cle: l.cle }));
    },
    async reprendre(avant) {
      const abandonnees = tout.filter((l) => l.etat === "en_cours" && l.priseLe && l.priseLe < avant);
      for (const l of abandonnees) l.etat = "a_envoyer";
      return abandonnees.length;
    },
    async echecs() {
      return tout.filter((l) => l.etat === "echec").map((l) => ({ tenantId: l.tenantId, id: l.id, destination: l.destination, route: l.route, nombreEssais: l.nombreEssais, derniereErreur: l.derniereErreur ?? null, creeLe: l.creeLe }));
    },
    async renvoyer(r, appelant, options) {
      verifierAppelant(appelant);
      const l = trouver(r);
      if (!l || l.etat !== "echec") return false;
      if (!options?.confirmerAnciennete && maintenant() - l.creeLe.getTime() > CONSERVATION_IDEMPOTENCE_JOURS * 86_400_000) throw new ErreurApi("regle_metier", MESSAGE_TROP_ANCIENNE);
      journal.push({ action: "renvoi", ligne: l.id, acteur: appelant.acteur });
      Object.assign(l, { etat: "a_envoyer", nombreEssais: 0 });
      delete l.prochainEssai;
      return true;
    },
  };
}
