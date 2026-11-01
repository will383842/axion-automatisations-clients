import { type Brique, type Fiche, type Json, type ModuleExecutable, type Sortie, versEvenements } from "./contrat.ts";

// Aucun réseau par défaut : l'échange passe par l'entrée standard (A-331). Liste fermée : tout autre réseau est refusé.
// Si un réseau devenait nécessaire, ce serait un réseau par exécution, jamais partagé entre exécutions ni entre clients.
export const RESEAUX_PERMIS = ["none"] as const;
const RESEAU_PAR_DEFAUT = "none";
// Dépôt seul : ni « : » ni « @ » (étiquette ou empreinte), pas de tiret initial (une option de docker).
const DEPOT_IMAGE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
export const LIMITES = { memoire: "256m", pids: 64, cpus: "1" } as const;
export const DELAI_MAX_MS = 60_000;

// Arguments d'un conteneur à part : image par empreinte, aucun coffre, aucun jeton, aucune variable, aucun volume, aucun réseau.
export function argumentsConteneur(brique: Brique, options: { reseau?: string } = {}): string[] {
  const reseau = options.reseau ?? RESEAU_PAR_DEFAUT;
  if (!/^sha256:[0-9a-f]{64}$/.test(brique.empreinte)) throw new Error(`${brique.nom} : l'empreinte sha256 est obligatoire`);
  if (brique.version === "" || brique.version.toLowerCase() === "latest") throw new Error(`${brique.nom} : version « latest » ou vide interdite`);
  if (brique.licence.trim() === "") throw new Error(`${brique.nom} : licence relue obligatoire`);
  if (!DEPOT_IMAGE.test(brique.image)) throw new Error(`${brique.nom} : image « ${brique.image} » refusée (dépôt en minuscules, sans « : », sans « @ », sans tiret initial)`);
  if (!(RESEAUX_PERMIS as readonly string[]).includes(reseau)) throw new Error(`${brique.nom} : réseau « ${reseau} » refusé, seul « ${RESEAUX_PERMIS.join(", ")} » est permis`);
  return [
    "run",
    "--rm",
    "--interactive",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=10001:10001",
    `--network=${reseau}`,
    `--memory=${LIMITES.memoire}`,
    `--memory-swap=${LIMITES.memoire}`,
    `--pids-limit=${LIMITES.pids}`,
    `--cpus=${LIMITES.cpus}`,
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    `${brique.image}@${brique.empreinte}`,
  ];
}

// Le lanceur reçoit un signal d'arrêt : au délai maximal il doit tuer le conteneur.
export type LanceurConteneur = (args: string[], entree: Json, signal?: AbortSignal) => Promise<Sortie>;

// Module enveloppe : même forme qu'un module en code, le conteneur étant lancé par le lanceur injecté.
// La sortie du lanceur est validée puis renvoyée sous la forme unique des événements ; le délai maximal est tenu ici.
export function creerModuleEnveloppe(brique: Brique, fiche: Fiche, lanceur: LanceurConteneur, options: { delaiMs?: number } = {}): ModuleExecutable {
  const args = argumentsConteneur(brique);
  const delaiMs = options.delaiMs ?? DELAI_MAX_MS;
  return {
    fiche,
    async executer(entree) {
      const controle = new AbortController();
      let minuteur: NodeJS.Timeout | undefined;
      const delai = new Promise<never>((_, rejeter) => {
        minuteur = setTimeout(() => {
          controle.abort();
          rejeter(new Error(`${brique.nom} : délai de ${delaiMs} ms dépassé, conteneur interrompu`));
        }, delaiMs);
      });
      try {
        const sortie = await Promise.race([lanceur(args, entree, controle.signal), delai]);
        return { evenements: versEvenements(sortie, fiche.evenements) };
      } finally {
        clearTimeout(minuteur);
      }
    },
  };
}
