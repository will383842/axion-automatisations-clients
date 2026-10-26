import { estOption, ReglageRefuse } from "./options.ts";
import { trouverEnClair } from "./references.ts";
import type { ModuleSdk } from "./valider.ts";

// Valeurs par défaut tirées du schéma. B-353 : une option sans défaut vaut « désactivée », un défaut « activé » est refusé.
export function defauts(module: Pick<ModuleSdk, "reglages">): Record<string, unknown> {
  const sortie: Record<string, unknown> = {};
  for (const [nom, champ] of Object.entries(module.reglages.shape)) {
    const lecture = champ.safeParse(undefined);
    const valeur = lecture.success ? lecture.data : undefined;
    if (estOption(champ)) {
      if (valeur === true) throw new ReglageRefuse("defaut_option_active", nom);
      sortie[nom] = false;
    } else if (valeur !== undefined) sortie[nom] = valeur;
  }
  const clair = trouverEnClair(sortie)[0];
  if (clair) throw new ReglageRefuse("reglage.valeur_en_clair", clair);
  return sortie;
}
