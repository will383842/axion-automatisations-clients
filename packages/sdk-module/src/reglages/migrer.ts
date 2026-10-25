import { defauts } from "./defauts.ts";
import { estObjet, figerProfond, validerReglages, type ModuleSdk, type Reglages } from "./valider.ts";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export type Exemple = { version: string; reglages: unknown };

// A-171 : l'instance reste sur l'ancienne version quand cette erreur est levée (T4-28).
export class MigrationRefusee extends Error {
  readonly code = "migration_refusee";
  constructor(readonly raison: string) {
    super(`migration_refusee : ${raison}`);
  }
}

const comparer = (a: string, b: string) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  return (x[0]! - y[0]!) || (x[1]! - y[1]!) || (x[2]! - y[2]!);
};

// Chaîne les migrations des versions publiées entre `depuis` et la version du module ; garde les valeurs du client (B-354).
export function migrerReglages(module: ModuleSdk, depuis: string, reglages: unknown, versions: readonly string[] = [module.version]): Reglages {
  if (typeof module.migrer !== "function") throw new MigrationRefusee("la version n'a pas de fonction migrer");
  if (!SEMVER.test(depuis) || comparer(depuis, module.version) > 0) throw new MigrationRefusee(`version de départ « ${String(depuis).slice(0, 20)} » inconnue`);
  if (!estObjet(reglages)) throw new MigrationRefusee("les réglages du client ne sont pas un groupe de valeurs");
  const pas = versions.filter((v) => SEMVER.test(v) && comparer(v, depuis) > 0 && comparer(v, module.version) <= 0).sort(comparer);
  if (!pas.length && comparer(depuis, module.version) < 0) pas.push(module.version);
  let courant: unknown;
  let version = depuis;
  try {
    courant = figerProfond(structuredClone(reglages));
    for (const v of pas) {
      const rendu = module.migrer(version, courant);
      if (!estObjet(rendu) || typeof (rendu as { then?: unknown }).then === "function") throw new Error("résultat inattendu");
      courant = figerProfond(structuredClone(rendu));
      version = v;
    }
  } catch {
    throw new MigrationRefusee(`échec de la migration depuis ${version}`);
  }
  let complet: Record<string, unknown>;
  try {
    complet = { ...defauts(module), ...(courant as object) };
  } catch {
    throw new MigrationRefusee("les valeurs par défaut du module sont refusées");
  }
  const r = validerReglages(module, complet);
  if (!r.ok) throw new MigrationRefusee(r.erreurs.map((e) => `${e.champ} : ${e.message}`).join(" ; "));
  return r.valeurs;
}

const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (estObjet(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// A-297 : rejoue migrer 100 fois sur les réglages d'exemple de chaque version publiée ; le résultat doit être identique.
export function verifierMigrations(module: ModuleSdk, exemples: readonly Exemple[], publiees: readonly string[] = [module.version]) {
  const erreurs: string[] = [];
  for (const v of publiees) if (!exemples.some((e) => e.version === v)) erreurs.push(`version ${v} : réglages d'exemple absents`);
  for (const ex of exemples) {
    const vus = new Set<string>();
    try {
      for (let i = 0; i < 100; i++) vus.add(canon(migrerReglages(module, ex.version, ex.reglages, publiees)));
    } catch (e) {
      erreurs.push(`version ${ex.version} : ${e instanceof MigrationRefusee ? e.raison : "échec"}`);
      continue;
    }
    if (vus.size > 1) erreurs.push(`version ${ex.version} : migrer n'est pas déterministe`);
  }
  return { ok: erreurs.length === 0, erreurs };
}
