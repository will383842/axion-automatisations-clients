import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import { gardeIndisponible, type ValkeyEnvois } from "./arret-urgence.ts";
import { cleAbaisse, cleDernier, cleJour, cleMinute, clePremier, cleReportes, decrementer, incrementer, lire, lireNombre, poser, type BoiteCle } from "./compteurs.ts";
import { jourParis, minuitSuivant, ecartJours, plafondDeMontee, premierJourEffectif } from "./montee.ts";

// Plafonds d'envoi par boîte (T4-45, A-206 mutualisé, A-274, A-275, B-193, C-085).
// plafond du jour = min(montée, limite du fournisseur avec marge de 20 %, plafond fixé par AXION IA pour le client, plafond abaissé par un 429 du fournisseur).
// Au-delà : aucun échec, un REPORT au jour suivant (erreur de classe quota, attente jusqu'à minuit de Paris), compté pour l'équipe. Aucune limite relevée = aucune limite inventée.
export type Fournisseur = "microsoft365" | "gmail" | "imap";
export interface LimiteFournisseur { parJour?: number; parMinute?: number }
export interface ConfigPlafonds { limites: Partial<Record<Fournisseur, LimiteFournisseur>> }
export const MARGE_FOURNISSEUR = 0.8;

export interface ContextePlafonds {
  valkey: ValkeyEnvois;
  config: ConfigPlafonds;
  tenantId: string;
  // Boîte d'envoi : le compteur est par (client, boîte), commun à toutes les instances qui l'utilisent.
  boite: string;
  fournisseur: Fournisseur;
  // Plafond du client, fixé par AXION IA dans la configuration de l'instance.
  plafondClient?: number;
  // Réglages du client : jamais lus pour fixer un plafond ; une demande qui dépasse est ignorée et tracée.
  reglagesClient?: unknown;
  maintenant?: () => Date;
  tracer?: (code: string) => void;
}
export interface Reservation { cleJour: string; cleMinute?: string }

const report = (attente: number) => new ErreurConnecteur("quota", "plafond_atteint", attente);
const entierPositif = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const marge = (v: number | undefined) => (v === undefined ? undefined : Math.max(Math.floor(v * MARGE_FOURNISSEUR), 0));

function suivreDemandeClient(c: ContextePlafonds, plafond: number): void {
  const demande = (c.reglagesClient as { plafondEnvoisParJour?: unknown } | null | undefined)?.plafondEnvoisParJour;
  if (demande !== undefined && !(typeof demande === "number" && demande <= plafond)) c.tracer?.("reglage_client_ignore");
}

export async function reserverEnvoi(c: ContextePlafonds): Promise<Reservation> {
  const maintenant = (c.maintenant ?? (() => new Date()))();
  const jour = jourParis(maintenant);
  const cle: BoiteCle = { tenantId: c.tenantId, boite: c.boite };
  const limite = c.config.limites[c.fournisseur];
  try {
    await poser(c.valkey, clePremier(cle), jour, true);
    const premier = (await lire(c.valkey, clePremier(cle))) ?? jour;
    const dernier = await lire(c.valkey, cleDernier(cle));
    const effectif = premierJourEffectif(premier, dernier, jour);
    if (effectif !== premier) await poser(c.valkey, clePremier(cle), effectif);
    const montee = plafondDeMontee(ecartJours(effectif, jour) + 1);
    const abaisse = await lireNombre(c.valkey, cleAbaisse(cle, jour));
    const plafond = Math.min(montee, marge(entierPositif(limite?.parJour)) ?? Infinity, entierPositif(c.plafondClient) ?? Infinity, abaisse ?? Infinity);
    suivreDemandeClient(c, plafond);
    const minuteMax = marge(entierPositif(limite?.parMinute));

    const kJour = cleJour(cle, jour);
    if ((await incrementer(c.valkey, kJour)) > plafond) {
      await decrementer(c.valkey, kJour);
      await incrementer(c.valkey, cleReportes(cle, jour));
      throw report(minuitSuivant(maintenant));
    }
    let kMinute: string | undefined;
    if (minuteMax !== undefined) {
      kMinute = cleMinute(cle, maintenant.toISOString().slice(0, 16));
      if ((await incrementer(c.valkey, kMinute, 120)) > minuteMax) {
        await decrementer(c.valkey, kMinute);
        await decrementer(c.valkey, kJour);
        await incrementer(c.valkey, cleReportes(cle, jour));
        throw report(Math.floor(maintenant.getTime() / 60_000) * 60_000 + 60_000);
      }
    }
    await poser(c.valkey, cleDernier(cle), jour);
    return { cleJour: kJour, ...(kMinute === undefined ? {} : { cleMinute: kMinute }) };
  } catch (e) {
    throw e instanceof ErreurConnecteur ? e : gardeIndisponible();
  }
}

// L'envoi n'a pas eu lieu : la place est rendue (jamais un renvoi d'un message déjà parti : on ne rend rien dans le doute).
export async function rendreEnvoi(c: ContextePlafonds, r: Reservation): Promise<void> {
  await decrementer(c.valkey, r.cleJour).catch(() => undefined);
  if (r.cleMinute) await decrementer(c.valkey, r.cleMinute).catch(() => undefined);
}

// Le fournisseur a répondu 429 : le plafond du jour devient ce qui est déjà parti.
export async function noterLimiteAtteinte(c: ContextePlafonds): Promise<void> {
  const maintenant = (c.maintenant ?? (() => new Date()))();
  const jour = jourParis(maintenant);
  const cle: BoiteCle = { tenantId: c.tenantId, boite: c.boite };
  try {
    const parti = (await lireNombre(c.valkey, cleJour(cle, jour))) ?? 0;
    const deja = await lireNombre(c.valkey, cleAbaisse(cle, jour));
    if (deja === undefined || parti < deja) await poser(c.valkey, cleAbaisse(cle, jour), String(parti));
  } catch {
    throw gardeIndisponible();
  }
}
