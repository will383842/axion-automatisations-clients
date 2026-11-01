import { type Brique, type Fiche, type Json, type ModuleExecutable, type Sortie, versEvenements } from "./contrat.ts";

// Réseau qui ne joint que l'exécuteur ; les noms des réseaux du socle, de la sortie et du coffre sont refusés (A-331).
export const RESEAU_ENVELOPPE = "enveloppe";
const RESEAUX_REFUSES = /^(host|none|default|sortie|executeur-interne|interne|entree|openbao|courtier|donnees)/i;

// Arguments d'un conteneur à part : image par empreinte, aucun coffre, aucun jeton, aucune variable, aucun volume.
export function argumentsConteneur(brique: Brique, options: { reseau?: string } = {}): string[] {
  const reseau = options.reseau ?? RESEAU_ENVELOPPE;
  if (!/^sha256:[0-9a-f]{64}$/.test(brique.empreinte)) throw new Error(`${brique.nom} : l'empreinte sha256 est obligatoire`);
  if (brique.version === "" || brique.version === "latest") throw new Error(`${brique.nom} : version « latest » ou vide interdite`);
  if (brique.licence.trim() === "") throw new Error(`${brique.nom} : licence relue obligatoire`);
  if (reseau !== RESEAU_ENVELOPPE || RESEAUX_REFUSES.test(reseau)) throw new Error(`${brique.nom} : réseau « ${reseau} » refusé, seul « ${RESEAU_ENVELOPPE} » est permis`);
  return [
    "run",
    "--rm",
    "--interactive",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=10001:10001",
    `--network=${reseau}`,
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    `${brique.image}@${brique.empreinte}`,
  ];
}

export type LanceurConteneur = (args: string[], entree: Json) => Promise<Sortie>;

// Module enveloppe : même forme qu'un module en code, le conteneur étant lancé par le lanceur injecté.
export function creerModuleEnveloppe(brique: Brique, fiche: Fiche, lanceur: LanceurConteneur): ModuleExecutable {
  const args = argumentsConteneur(brique);
  return {
    fiche,
    async executer(entree) {
      const sortie = await lanceur(args, entree);
      versEvenements(sortie);
      return sortie;
    },
  };
}
