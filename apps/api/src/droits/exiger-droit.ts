import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { ErreurApi } from "../plugins/erreurs.js";
import { autorise, type Action, type Role } from "./matrice.js";
import { couvreTousLesClients, dansPortee, type Portee } from "./portee.js";

export interface MembreDroits { sujet: string; role: Role; actif: boolean; portee: Portee }
export interface TraceRefus { action: string; sujet: string | null; motif: "droit_refuse" | "hors_portee"; idTrace: string }
// Rien n'est gardé en cache : le membre et l'absence sont relus à chaque requête (un changement de rôle ou la fin d'une absence agit tout de suite).
export interface DepsDroits {
  membre(requete: FastifyRequest): Promise<MembreDroits | undefined>;
  absenceOuverte(membre: MembreDroits): Promise<boolean>;
  tracer(e: TraceRefus): Promise<void>;
}
// La portée est obligatoire et explicite (pas de défaut) : soit l'extracteur du client visé, soit « globale » avec sa raison.
// Une route globale refuse tout second administrateur dont la portée ne couvre pas tous les clients (404) tant que son filtrage par portée n'est pas prouvé : échec fermé.
export type OptionsDroit = { accordClient?: (requete: FastifyRequest) => Promise<boolean> } & ({ client: (requete: FastifyRequest) => unknown } | { globale: string })

// Crochet à poser sur chaque route de la console. Refus : 403 « action_interdite » tracé ; ressource hors portée : 404 « introuvable » (jamais 403, qui confirmerait l'existence).
export function exigerDroit(action: Action, d: DepsDroits, o: OptionsDroit): preHandlerAsyncHookHandler & { action: Action } {
  const crochet: preHandlerAsyncHookHandler = async (requete) => {
    const refuser = async (motif: TraceRefus["motif"], membre?: MembreDroits): Promise<never> => {
      // La trace ne masque jamais le refus : si elle échoue, l'échec est journalisé et le refus part quand même.
      await d.tracer({ action, sujet: membre?.sujet ?? null, motif, idTrace: requete.id }).catch((e: unknown) => requete.log.error({ err: e }, "trace du refus impossible"));
      throw motif === "hors_portee" ? new ErreurApi("introuvable", "Ressource introuvable.") : new ErreurApi("action_interdite", "Action non permise.");
    };
    const membre = await d.membre(requete).catch(() => undefined);
    if (!membre?.actif) return refuser("droit_refuse");
    const absenceOuverte = membre.role === "second_administrateur" && (await d.absenceOuverte(membre).catch(() => false));
    const accordClient = o.accordClient ? await o.accordClient(requete).catch(() => false) : false;
    if (!autorise(membre.role, action, { absenceOuverte, accordClient })) return refuser("droit_refuse", membre);
    if ("client" in o ? !dansPortee(membre, o.client(requete)) : !couvreTousLesClients(membre)) return refuser("hors_portee", membre);
  };
  return Object.assign(crochet, { action });
}
