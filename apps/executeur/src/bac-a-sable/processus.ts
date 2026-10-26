import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLES_PUBLIQUES, type ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.js";
import { type Artefact } from "../../../../packages/sdk-module/src/emballage/signer.js";
import { verifierArtefact } from "../../../../packages/sdk-module/src/emballage/verifier.js";
import { ModuleNonSigneError } from "../noyau/charger-module.ts";
import { estMessageEnfant, type Json, type MessageParent } from "./canal.ts";
import { argumentsEnfant, LIMITES_DEFAUT, type Limites } from "./limites.ts";

const AMORCE = fileURLToPath(new URL("./enfant.mjs", import.meta.url));

export interface DemandeExecution {
  executionId: string;
  entree: Json;
  jeton?: string | undefined;
  cles?: readonly ClePublique[] | undefined;
  limites?: Limites;
}
export type ResultatExecution =
  | { statut: "fait"; valeur: Json }
  | { statut: "echec"; message?: string }
  | { statut: "delai_depasse" };

// Un processus par exécution, jamais réutilisé : vérifié AVANT le lancement, tué à la fin quoi qu'il arrive.
export async function executerIsole(artefact: Artefact, d: DemandeExecution): Promise<ResultatExecution> {
  const v = verifierArtefact(artefact, d.cles ?? CLES_PUBLIQUES);
  const js = v.ok ? v.fichiers["module.js"] : undefined;
  if (!v.ok || js === undefined) throw new ModuleNonSigneError();
  const limites = d.limites ?? LIMITES_DEFAUT;
  const enfant = fork(AMORCE, [], {
    execPath: process.execPath,
    execArgv: argumentsEnfant(AMORCE, limites).slice(0, -1),
    env: { AXION_EXECUTION_ID: d.executionId },
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise<ResultatExecution>((fin) => {
    let verdict: ResultatExecution | undefined;
    // Le résultat n'est rendu qu'une fois l'enfant réellement parti : plus de processus vivant derrière un résultat.
    const rendre = (r: ResultatExecution) => {
      if (verdict) return;
      verdict = r;
      clearTimeout(minuterie);
      enfant.kill("SIGKILL");
    };
    const minuterie = setTimeout(() => rendre({ statut: "delai_depasse" }), limites.dureeMs);
    enfant.on("message", (m: unknown) => {
      if (!estMessageEnfant(m)) return rendre({ statut: "echec" });
      rendre(m.type === "resultat" ? { statut: "fait", valeur: m.valeur } : { statut: "echec", message: m.message });
    });
    enfant.on("error", () => rendre({ statut: "echec" }));
    enfant.on("exit", () => {
      rendre({ statut: "echec" });
      fin(verdict as ResultatExecution);
    });
    const lancer: MessageParent = { type: "lancer", executionId: d.executionId, code: Buffer.from(js).toString("base64"), entree: d.entree, ...(d.jeton === undefined ? {} : { jeton: d.jeton }) };
    enfant.send(lancer);
  });
}
