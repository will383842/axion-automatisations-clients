import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Quotas par palier (A-247, C-188) : taille de la base, taille des fichiers, nombre de personnes. Les valeurs par défaut viennent d'un FICHIER DE CONFIGURATION
// lu au démarrage (apps/api/config/quotas.json), jamais du code ; aucun prix ici. Valeurs à valider par Will avant le lot 8a.
// Surcharge par client : les colonnes quota_* de bases_client (existantes, aucune migration). Le passage par conditions_commerciales (héritage T2-08)
// demande un nouveau type de condition, donc une migration et une décision d'architecte : dette portée dans la PR.
export const PALIERS = ["essentiel", "pro", "etendu"] as const;
export type Palier = (typeof PALIERS)[number];
export interface Quotas {
  baseOctets: number;
  fichiersOctets: number;
  personnes: number;
}
export type ConfigQuotas = Readonly<Record<Palier, Quotas>>;
// Surcharge d'un client : une valeur absente ou nulle retombe sur le palier.
export type Surcharge = { [K in keyof Quotas]?: number | null | undefined };

export const CHEMIN_CONFIG_QUOTAS = fileURLToPath(new URL("../../config/quotas.json", import.meta.url));

const Quota = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Palier = z.strictObject({ base_octets: Quota, fichiers_octets: Quota, personnes: Quota });
const Fichier = z.strictObject({ avertissement: z.string().optional(), essentiel: Palier, pro: Palier, etendu: Palier });

const versQuotas = (p: z.infer<typeof Palier>): Quotas => ({ baseOctets: p.base_octets, fichiersOctets: p.fichiers_octets, personnes: p.personnes });

export function lireConfigQuotas(texte: string): ConfigQuotas {
  const f = Fichier.parse(JSON.parse(texte));
  return Object.freeze({ essentiel: versQuotas(f.essentiel), pro: versQuotas(f.pro), etendu: versQuotas(f.etendu) });
}
export function chargerConfigQuotas(chemin: string = CHEMIN_CONFIG_QUOTAS): ConfigQuotas {
  return lireConfigQuotas(readFileSync(chemin, "utf8"));
}

export function quotasEffectifs(config: ConfigQuotas, palier: Palier, surcharge: Surcharge = {}): Quotas {
  if (!Object.hasOwn(config, palier)) throw new Error("palier inconnu");
  const base = config[palier];
  const valeur = (v: number | null | undefined, defaut: number): number => {
    if (v === null || v === undefined) return defaut;
    return Quota.parse(v);
  };
  return { baseOctets: valeur(surcharge.baseOctets, base.baseOctets), fichiersOctets: valeur(surcharge.fichiersOctets, base.fichiersOctets), personnes: valeur(surcharge.personnes, base.personnes) };
}
