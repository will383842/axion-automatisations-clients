import type { Journal } from "./journal.js";
import type { Verrou } from "./verrou.js";

// Renouvellement en avance (T4-40) : un seul appel au fournisseur par connexion, jamais deux fois le même jeton tournant.
// Ordre : verrou → revérification → appel → écriture du NOUVEAU jeton (OpenBao, nouvelle version) → libération.
// Aucune valeur de jeton dans une erreur ni dans le journal : les erreurs ne portent qu'un code.
export const AVANCE_MS = 10 * 60_000;
export interface Secret { access_token: string; refresh_token: string; expires_at: number; duree_s?: number } // expires_at en secondes
export interface ConnexionARenouveler { connexionId: string; tenantId: string; cheminCoffre: string; instanceIds: readonly string[] }
export interface ReponseFournisseur { access_token: string; refresh_token?: string; expires_in: number }

// invalid_grant : jeton refusé. refuse : le fournisseur a répondu non sans consommer le jeton (5xx, quota). incertain : délai ou coupure, le jeton a peut-être été consommé.
export class ErreurFournisseur extends Error {
  constructor(readonly kind: "invalid_grant" | "refuse" | "incertain") { super(kind); this.name = "ErreurFournisseur"; }
}
export class ErreurRenouvellement extends Error {
  constructor(readonly code: "invalid_grant" | "connexion_rouge" | "a_verifier" | "ecriture_echouee" | "verrou_perdu" | "reponse_incertaine" | "fournisseur_indisponible" | "attente_depassee" | "lecture_echouee") { super(code); this.name = "ErreurRenouvellement"; }
}
export interface PortsRenouvellement {
  verrou: Verrou;
  journal: Journal;
  maintenant(): number;
  attendre(ms: number): Promise<void>;
  lire(chemin: string, signal?: AbortSignal): Promise<Secret>; // version courante seulement : jamais la précédente
  ecrire(chemin: string, secret: Secret): Promise<void>; // nouvelle version KV
  fournisseur(refreshToken: string, signal?: AbortSignal): Promise<ReponseFournisseur>;
  etatConnexion(connexionId: string): Promise<"ok" | "a_verifier" | "rouge">;
  marquerRouge(connexionId: string): Promise<void>;
  mettreEnPause(instanceId: string, classe: "identification"): Promise<void>;
  marquerAVerifier(connexionId: string): Promise<void>;
  alerter(connexionId: string, code: string): Promise<void>; // alerte équipe, jamais d'e-mail au client
  bailMs: number; // doit dépasser delaiFournisseurMs : l'appel est abandonné avant la fin du bail
  delaiFournisseurMs: number;
  essaisEcriture: number;
  attenteMaxMs: number;
}
export interface Acces { jetonAcces: string; expireA: number } // expireA en secondes

export function doitRenouveler(s: Secret, maintenantMs: number): boolean {
  const restantMs = s.expires_at * 1000 - maintenantMs;
  return restantMs < AVANCE_MS || (s.duree_s !== undefined && restantMs < (s.duree_s * 1000) / 3);
}

const acces = (s: Secret): Acces => ({ jetonAcces: s.access_token, expireA: s.expires_at });

async function avecDelai<T>(ms: number, appel: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const c = new AbortController();
  let t: ReturnType<typeof setTimeout> | undefined;
  const fin = new Promise<never>((_, ko) => { t = setTimeout(() => { c.abort(); ko(new ErreurFournisseur("incertain")); }, ms); });
  try { return await Promise.race([appel(c.signal), fin]); } finally { clearTimeout(t); }
}

export async function renouvelerSiBesoin(p: PortsRenouvellement, c: ConnexionARenouveler): Promise<Acces> {
  const trace = (evenement: string, code?: string) => p.journal.tracer({ evenement, connexionId: c.connexionId, tenantId: c.tenantId, ...(code ? { code } : {}) });
  const echec = (code: ErreurRenouvellement["code"]): never => { trace("renouvellement_echec", code); throw new ErreurRenouvellement(code); };
  // Une connexion rouge ou « à vérifier » n'est jamais renouvelée toute seule : le jeton a pu être consommé.
  const refuserSiBloquee = async () => {
    const e = await p.etatConnexion(c.connexionId).catch(() => "a_verifier" as const);
    if (e === "rouge") echec("connexion_rouge");
    if (e === "a_verifier") echec("a_verifier");
  };
  const lire = () => p.lire(c.cheminCoffre).catch(() => echec("lecture_echouee"));

  await refuserSiBloquee();
  const fin = p.maintenant() + p.attenteMaxMs;
  let secret = await lire();
  for (;;) {
    if (!doitRenouveler(secret, p.maintenant())) return acces(secret);
    const verrou = await p.verrou.prendre(c.connexionId, p.bailMs);
    if (verrou !== null) return renouveler(verrou);
    // Pas le verrou : on attend le résultat du titulaire, on ne renouvelle pas soi-même.
    if (p.maintenant() >= fin) echec("attente_depassee");
    await p.attendre(25);
    await refuserSiBloquee();
    secret = await lire();
  }

  async function renouveler(verrou: string): Promise<Acces> {
    let liberer = true;
    try {
      // Revérifier sous verrou : un autre a pu renouveler entre ma lecture et ma prise du verrou.
      const actuel = await lire();
      if (!doitRenouveler(actuel, p.maintenant())) return acces(actuel);
      await refuserSiBloquee();
      // Titulaire encore ? Sinon (bail perdu, autre processus) : aucun appel au fournisseur.
      if (!(await p.verrou.prolonger(c.connexionId, verrou, p.bailMs).catch(() => false))) { liberer = false; return echec("verrou_perdu"); }
      let reponse: ReponseFournisseur;
      try {
        reponse = await avecDelai(p.delaiFournisseurMs, (signal) => p.fournisseur(actuel.refresh_token, signal));
      } catch (e) {
        const kind = e instanceof ErreurFournisseur ? e.kind : "incertain";
        if (kind === "invalid_grant") {
          await p.marquerRouge(c.connexionId);
          for (const i of c.instanceIds) await p.mettreEnPause(i, "identification");
          await p.alerter(c.connexionId, "invalid_grant").catch(() => undefined);
          return echec("invalid_grant");
        }
        if (kind === "refuse") return echec("fournisseur_indisponible");
        // Réponse incertaine : le jeton a peut-être été consommé. Aucun second appel, le test de connexion décidera.
        liberer = false;
        await p.marquerAVerifier(c.connexionId).catch(() => undefined);
        await p.alerter(c.connexionId, "reponse_incertaine").catch(() => undefined);
        return echec("reponse_incertaine");
      }
      // Le fournisseur a répondu : le jeton est consommé. Désormais seulement des écritures, jamais un second appel.
      const neuf: Secret = { access_token: reponse.access_token, refresh_token: reponse.refresh_token ?? actuel.refresh_token, expires_at: Math.floor(p.maintenant() / 1000) + reponse.expires_in, duree_s: reponse.expires_in };
      for (let essai = 1; essai <= p.essaisEcriture; essai++) {
        try {
          await p.ecrire(c.cheminCoffre, neuf);
          trace("renouvelle");
          return acces(neuf);
        } catch {
          trace("ecriture_essai_echec");
          await p.verrou.prolonger(c.connexionId, verrou, p.bailMs).catch(() => false);
          if (essai < p.essaisEcriture) await p.attendre(50 * essai);
        }
      }
      liberer = false;
      await p.marquerAVerifier(c.connexionId).catch(() => undefined);
      await p.alerter(c.connexionId, "ecriture_echouee").catch(() => undefined);
      return echec("ecriture_echouee");
    } finally {
      if (liberer) await p.verrou.liberer(c.connexionId, verrou).catch(() => undefined);
    }
  }
}
