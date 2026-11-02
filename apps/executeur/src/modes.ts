// Mode de l'exécuteur : un réglage, pas une autre image (A-012, A-284). En V1, mutualisé seulement.
export type Mode = "mutualise";

export function lireMode(env: Record<string, string | undefined>): Mode {
  const brut = env.EXECUTEUR_MODE;
  if (brut === undefined || brut === "mutualise") return "mutualise";
  if (brut === "relie" || brut === "autonome") throw new Error(`mode « ${brut} » refusé : prévu en V2, seul « mutualise » est accepté en V1`);
  throw new Error(`mode inconnu « ${brut} » : seul « mutualise » est accepté en V1`);
}
