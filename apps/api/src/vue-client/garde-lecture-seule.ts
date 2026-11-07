import type { FastifyInstance, FastifyRequest } from "fastify";
import { ErreurApi } from "../plugins/erreurs.js";
import type { RegistreVues } from "./ouvrir.js";

// Lecture seule imposée par le serveur (B-067) : crochet racine, posé EN PREMIER dans construireServeur. Tant que l'acteur a une vue vivante, seules passent les routes de cette liste FERMÉE
// (identifiées par leur motif `routeOptions.url`, jamais par l'adresse brute) ; tout le reste — écriture, export, téléchargement, route inconnue ou future — répond 403.
export const PERMISES_EN_VUE = [
  "GET /api/console/v1/clients/:id/vue-client",
  "POST /api/console/v1/clients/:id/vue-client/pages",
  "POST /api/console/v1/clients/:id/vue-client/fermer",
  "POST /api/v1/donnees/:nom", // lecture seule par construction : refuse le contenu d'un autre client faute de vue rangée
] as const;
const PERMISES: ReadonlySet<string> = new Set(PERMISES_EN_VUE);

export interface DepsGarde {
  registre: RegistreVues;
  // Acteur de la session d'équipe (jamais un en-tête ni le corps). Illisible : aucune vue n'est retrouvable, les crochets de la route décident.
  acteur(requete: FastifyRequest): Promise<string | undefined>;
}

export function brancherGardeLectureSeule(serveur: FastifyInstance, d: DepsGarde): void {
  serveur.addHook("onRequest", async (requete) => {
    const acteur = await d.acteur(requete).catch(() => undefined);
    const vue = acteur ? d.registre.vueDe(acteur) : undefined;
    if (!vue) return;
    if (!PERMISES.has(`${requete.method} ${requete.routeOptions?.url ?? ""}`)) throw new ErreurApi("action_interdite", "Action non permise.");
    // Autre client que celui de la vue : réponse d'une ressource absente.
    const id = (requete.params as { id?: string } | undefined)?.id;
    if (id !== undefined && id !== vue.tenantId) throw new ErreurApi("introuvable", "Ressource introuvable.");
  });
}
