import { POLITIQUES, type ClasseErreur } from "@axion-auto/sdk-module";
import type { Horloge } from "./ports.ts";

// Seul le code (liste fermée par expression) sort vers la console : jamais de message (A-323).
export class ErreurConnecteur extends Error {
  constructor(
    readonly classe: ClasseErreur,
    readonly code: string,
    readonly attenteJusqua?: number,
  ) {
    super(code);
  }
}

const CODE = /^[a-z][a-z0-9_]{2,63}$/;
const BASE_MS = 1000;
const ATTENTE_MAX_MS = 86_400_000;

export type Decision =
  | { action: "reessayer"; attenteMs: number }
  | { action: "pause"; code: string }
  | { action: "echec"; classe: ClasseErreur; code: string };

export function classer(erreur: unknown): { classe: ClasseErreur; code: string; attenteJusqua?: number } {
  if (!(erreur instanceof ErreurConnecteur)) return { classe: "definitive", code: "erreur_inconnue" };
  const code = CODE.test(erreur.code) ? erreur.code : "erreur_inconnue";
  return { classe: erreur.classe, code, ...(erreur.attenteJusqua === undefined ? {} : { attenteJusqua: erreur.attenteJusqua }) };
}

function attenteCroissante(essai: number, horloge: Horloge): number {
  const base = BASE_MS * 2 ** (essai - 1);
  const tire = horloge.alea();
  const alea = Number.isFinite(tire) ? Math.min(Math.max(tire, 0), 0.99) : 0;
  return Math.floor(base + alea * base * 0.5);
}

export function decider(erreur: unknown, essai: number, horloge: Horloge): Decision {
  const e = classer(erreur);
  if (e.classe === "definitive") return { action: "echec", classe: e.classe, code: e.code };
  if (e.classe === "identification") return { action: "pause", code: e.code };
  if (essai >= POLITIQUES.passagere.essais) return { action: "echec", classe: e.classe, code: "essais_epuises" };
  if (e.classe === "quota" && Number.isFinite(e.attenteJusqua)) {
    return { action: "reessayer", attenteMs: Math.min(Math.max(e.attenteJusqua! - horloge.maintenant(), 0), ATTENTE_MAX_MS) };
  }
  return { action: "reessayer", attenteMs: attenteCroissante(essai, horloge) };
}
