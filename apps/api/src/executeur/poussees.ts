// Poussées de la console vers l'exécuteur (A-340) : un canal Valkey par cellule (même forme que apps/executeur/src/console/poussees.ts).
// Le message ne porte que le type et l'identifiant d'instance : jamais un réglage ni un secret.
export const canalPoussees = (cellule: string): string => `executeur:poussees:${cellule}`;

export type TypePoussee = "pause" | "reprise" | "revocation" | "arret_envois";
const TYPES: readonly string[] = ["pause", "reprise", "revocation", "arret_envois"];
const CELLULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

export async function publierPoussee(valkey: { publish(canal: string, message: string): Promise<unknown> }, cellule: string, poussee: { type: TypePoussee; instanceId: string }): Promise<void> {
  if (cellule.length > 64 || !CELLULE.test(cellule) || !TYPES.includes(poussee.type) || !INSTANCE.test(poussee.instanceId)) throw new Error("poussée invalide");
  await valkey.publish(canalPoussees(cellule), JSON.stringify({ type: poussee.type, instanceId: poussee.instanceId }));
}
