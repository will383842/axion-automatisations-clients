export interface ContexteEtape {
  instanceId: string;
  executionId: string;
  etape: string;
  reglages: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  // Effet externe garanti : intention écrite avant, garantie du connecteur après une coupure.
  effet(action: string, element: string, entree?: unknown): Promise<void>;
}
export interface EtapeExecutable {
  executer(ctx: ContexteEtape): Promise<void>;
}

// C4 v0 ne porte pas de fonction par étape : le code est lié ici, par nom, et doit couvrir exactement les étapes déclarées.
export function lierEtapes(module: { etapes: readonly { nom: string }[] }, code: Record<string, EtapeExecutable>): void {
  const declarees = module.etapes.map((e) => e.nom);
  const manque = declarees.find((n) => !(n in code));
  if (manque) throw new Error(`étape déclarée sans code : ${manque}`);
  const enTrop = Object.keys(code).find((n) => !declarees.includes(n));
  if (enTrop) throw new Error(`code sans étape déclarée : ${enTrop}`);
}
