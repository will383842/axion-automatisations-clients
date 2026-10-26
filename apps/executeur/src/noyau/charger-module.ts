import { type ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.js";
import { type Artefact } from "../../../../packages/sdk-module/src/emballage/signer.js";
import { verifierArtefact } from "../../../../packages/sdk-module/src/emballage/verifier.js";

export class ModuleNonSigneError extends Error {
  readonly code = "module_non_signe";
  constructor() {
    super("module_non_signe");
  }
}

// Vérifie AVANT d'importer : tout échec = module_non_signe, aucune ligne du module évaluée.
// Le JavaScript est évalué depuis les octets vérifiés (URL data:), jamais relu sur le disque.
export async function chargerModule(artefact: Artefact, clesPubliques: readonly ClePublique[]): Promise<Record<string, unknown>> {
  const r = verifierArtefact(artefact, clesPubliques);
  if (!r.ok) throw new ModuleNonSigneError();
  const js = r.fichiers["module.js"];
  if (js === undefined) throw new ModuleNonSigneError();
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as Record<string, unknown>;
}
