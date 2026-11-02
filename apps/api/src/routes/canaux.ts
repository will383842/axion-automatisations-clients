import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { isIP } from "node:net";
import { RACINE_C1 } from "../canaux/boite-envoi.js";
import type { Magasin } from "../canaux/expediteur.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Échecs de la boîte d'envoi (C-403), pour l'équipe seule. Jamais le corps ni la réponse : seulement de quoi retrouver et renvoyer le message.
// Comme routeJournal, la route n'est branchée dans serveur.ts que par la fiche qui câble les routes de l'équipe.
const Confirmation = z.strictObject({ confirmerAnciennete: z.boolean().optional() }).optional();
const Ids = z.strictObject({ tenantId: z.uuid(), id: z.uuid() });
export function routeCanaux(serveur: FastifyInstance, o: { magasin: Magasin; exigerEquipe: preHandlerAsyncHookHandler }): void {
  serveur.get(`${RACINE_C1}/canaux/echecs`, { preHandler: o.exigerEquipe }, async () => ({ echecs: await o.magasin.echecs() }));
  // Remise à « a_envoyer » avec la MÊME clé : le Hub ou le CRM rejoue la même réponse au lieu de créer une seconde fois.
  serveur.post(`${RACINE_C1}/canaux/echecs/:tenantId/:id/renvoyer`, { preHandler: o.exigerEquipe }, async (requete) => {
    const p = Ids.safeParse(requete.params);
    if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const corps = Confirmation.safeParse(requete.body);
    if (!corps.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    // L'acteur vient du jeton vérifié par exigerEquipe, jamais du corps : sans lui, aucun renvoi.
    const acteur = typeof requete.identite?.sub === "string" ? requete.identite.sub : "";
    if (acteur.trim() === "") throw new ErreurApi("action_interdite", "Acteur non identifié.");
    const appelant = { acteur, ...(isIP(requete.ip) !== 0 && !requete.ip.includes("%") ? { ip: requete.ip } : {}) };
    if (!(await o.magasin.renvoyer(p.data, appelant, { confirmerAnciennete: corps.data?.confirmerAnciennete === true }))) throw new ErreurApi("introuvable", "Aucun échec à renvoyer.");
    return { renvoye: true };
  });
}
