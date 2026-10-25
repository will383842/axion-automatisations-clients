import { randomBytes } from "node:crypto";
import { ErreurCoffre, type OptionsBao } from "./coffre.js";

// Clés HMAC des échanges (C-015) : KV v2 sous technique/echanges/<canal>/<kid>, lues par le jeton « echanges » seulement.
// Par canal et par sens, une clé active et, pendant 24 h après une rotation, l'ancienne (annexe des contrats, section 0).
// coffre.ts n'ouvre que clients/ et transit/ : le montage technique/ a donc son propre appel, avec les mêmes garde-fous.

export type Sens = "emission" | "reception";
export interface CleEchange {
  kid: string;
  secret: Buffer;
}
export interface OptionsEchanges extends OptionsBao {
  maintenant?: () => number;
}

const CHEVAUCHEMENT_MS = 24 * 3600_000;
const DELAI_MS = 5000;
const CANAL = /^(?:c1|c2|c3|c6|c4-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const KID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SENS = new Set<string>(["emission", "reception"]);
const indisponible = () => new ErreurCoffre("coffre_indisponible");

type Reponse = { data?: { data?: Record<string, unknown>; metadata?: { version?: unknown }; keys?: unknown } } | undefined;

async function appelerTechnique(o: OptionsBao, methode: "GET" | "POST" | "LIST", chemin: string, corps?: unknown): Promise<Reponse> {
  let reponse: Response;
  try {
    reponse = await (o.fetch ?? fetch)(`${o.url}/v1/${chemin}`, {
      method: methode,
      headers: { "X-Vault-Token": o.jeton, ...(corps === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
      redirect: "error",
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch {
    throw indisponible();
  }
  if (reponse.status === 503) throw new ErreurCoffre((await reponse.text().catch(() => "")).toLowerCase().includes("sealed") ? "coffre_scelle" : "coffre_indisponible");
  if (reponse.status === 403) throw new ErreurCoffre("refuse");
  if (reponse.status === 404) throw new ErreurCoffre("introuvable");
  if (reponse.status >= 500) throw indisponible();
  if (reponse.status >= 300) throw new ErreurCoffre("requete_refusee");
  const texte = await reponse.text().catch(() => "");
  try {
    return texte ? (JSON.parse(texte) as Reponse) : undefined;
  } catch {
    throw indisponible();
  }
}

interface Enregistrement extends CleEchange {
  sens: Sens;
  creeLe: number;
  retireeLe: number | null;
  version: number;
}

export function creerClesEchanges(o: OptionsEchanges) {
  const maintenant = o.maintenant ?? Date.now;
  const canal = (c: string, s: string): string => {
    if (typeof c !== "string" || !CANAL.test(c) || !SENS.has(s)) throw new ErreurCoffre("requete_refusee");
    return c;
  };
  const chemin = (c: string, kid: string) => `technique/data/echanges/${c}/${kid}`;

  async function lireUne(c: string, kid: string): Promise<Enregistrement> {
    const r = await appelerTechnique(o, "GET", chemin(c, kid));
    const d = r?.data?.data ?? {};
    const secret = typeof d.secret === "string" ? Buffer.from(d.secret, "base64") : undefined;
    const version = Number(r?.data?.metadata?.version);
    const retireeLe = d.retiree_le === null ? null : d.retiree_le;
    if (!secret || secret.toString("base64") !== d.secret || secret.length !== 32 || !SENS.has(String(d.sens)) || typeof d.cree_le !== "number" || !(retireeLe === null || typeof retireeLe === "number") || !Number.isSafeInteger(version)) throw indisponible();
    return { kid, secret, sens: d.sens as Sens, creeLe: d.cree_le, retireeLe, version };
  }

  async function toutes(c: string, sens: Sens): Promise<Enregistrement[]> {
    let kids: unknown;
    try {
      kids = (await appelerTechnique(o, "LIST", `technique/metadata/echanges/${c}`))?.data?.keys;
    } catch (e) {
      if (e instanceof ErreurCoffre && e.code === "introuvable") return [];
      throw e;
    }
    if (!Array.isArray(kids) || kids.some((k) => typeof k !== "string" || !KID.test(k))) throw indisponible();
    return (await Promise.all((kids as string[]).map((k) => lireUne(c, k)))).filter((k) => k.sens === sens);
  }

  const acceptee = (k: Enregistrement) => k.retireeLe === null || maintenant() < k.retireeLe + CHEVAUCHEMENT_MS;
  // Choix déterministe de l'active : création la plus récente, puis kid le plus grand.
  const plusRecente = (a: Enregistrement, b: Enregistrement) => b.creeLe - a.creeLe || (a.kid < b.kid ? 1 : a.kid > b.kid ? -1 : 0);
  const actives = (cles: Enregistrement[]) => cles.filter((k) => k.retireeLe === null).sort(plusRecente);

  return {
    async cleActive(c: string, sens: Sens): Promise<CleEchange> {
      const active = actives(await toutes(canal(c, sens), sens))[0];
      if (!active) throw new ErreurCoffre("introuvable");
      return { kid: active.kid, secret: active.secret };
    },
    // Jamais plus de deux clés : l'active, et la dernière retirée encore dans les 24 h (les autres, venues d'une rotation concurrente ou interrompue, sont ignorées).
    async clesAcceptees(c: string, sens: Sens): Promise<CleEchange[]> {
      const cles = await toutes(canal(c, sens), sens);
      const retiree = cles.filter((k) => k.retireeLe !== null && acceptee(k)).sort((a, b) => (b.retireeLe ?? 0) - (a.retireeLe ?? 0) || plusRecente(a, b))[0];
      return [actives(cles)[0], retiree].filter((k): k is Enregistrement => k !== undefined).map(({ kid, secret }) => ({ kid, secret }));
    },
    // Rotation : l'active devient « retirée » (acceptée 24 h), une nouvelle clé prend sa place. Pas plus de deux clés acceptées.
    async tourner(c: string, sens: Sens): Promise<CleEchange> {
      canal(c, sens);
      const acceptees = (await toutes(c, sens)).filter(acceptee);
      if (acceptees.some((k) => k.retireeLe !== null)) throw new ErreurCoffre("requete_refusee");
      const kid = `${sens.slice(0, 3)}-${maintenant().toString(36)}-${randomBytes(3).toString("hex")}`;
      const secret = randomBytes(32);
      // Création seule (cas: 0) : une clé existante n'est jamais remplacée.
      await appelerTechnique(o, "POST", chemin(c, kid), { options: { cas: 0 }, data: { secret: secret.toString("base64"), sens, cree_le: maintenant(), retiree_le: null } });
      for (const ancienne of acceptees) {
        await appelerTechnique(o, "POST", chemin(c, ancienne.kid), { options: { cas: ancienne.version }, data: { secret: ancienne.secret.toString("base64"), sens, cree_le: ancienne.creeLe, retiree_le: maintenant() } });
      }
      return { kid, secret };
    },
  };
}
