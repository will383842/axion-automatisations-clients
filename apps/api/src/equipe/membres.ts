import { z } from "zod";
import { changementMembreAutorise, ROLES, type Role } from "../droits/matrice.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { ErreurKeycloak, type KeycloakAdmin } from "./keycloak-admin.js";

// Membres de l'équipe (T3-07c, plan T3-07 § 2.1-5). Keycloak et PostgreSQL ne se valident pas ensemble : les ordres sont imposés et rien n'est jamais supprimé.
//  - inviter : (1) utilisateur Keycloak créé DÉSACTIVÉ, (2) ligne de membres_equipe, (3) activation, (4) e-mail d'invitation derrière un interrupteur fermé par défaut ;
//  - désactiver : verrou des dirigeants actifs, ligne désactivée, PUIS Keycloak (l'API relit le membre à chaque requête : l'effet est immédiat dès l'étape base).
// Ni e-mail, ni identifiant Keycloak, ni détail d'une réponse de Keycloak ne sort dans une erreur, un journal ou une réponse.
export interface MembreEquipe { id: string; sujet: string; role: Role; actif: boolean; porteeClients: string[]; creeLe: Date; desactiveLe: Date | null }
export type ResultatDesactivation = { etat: "desactive" | "deja"; sujet: string } | { etat: "introuvable" } | { etat: "refuse" };
export type RegleDesactivation = (c: { cible: { sujet: string; role: string }; dirigeantsActifs: number }) => boolean;
export interface DepotMembres {
  lister(): Promise<MembreEquipe[]>;
  clientsExistent(ids: string[]): Promise<boolean>;
  inserer(m: { sujet: string; role: Role; porteeClients: string[] }, acteur: string): Promise<{ id: string }>;
  // Une seule transaction : verrou des dirigeants actifs, règle, UPDATE. Jamais de DELETE, jamais de réactivation.
  desactiver(o: { cibleId: string; acteur: { sujet: string; role: Role } }, regle: RegleDesactivation): Promise<ResultatDesactivation>;
}
export interface PortsMembres {
  keycloak: Pick<KeycloakAdmin, "chercherParEmail" | "creerUtilisateur" | "activer" | "envoyerActions" | "desactiver">;
  depot: DepotMembres;
  invitationOuverte(): boolean; // INVITATION_COURRIEL_OUVERTE : fermé par défaut (A3)
  journaliser(ligne: string): void;
}
export interface Acteur { sujet: string; role: Role }

const Invitation = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z.enum(ROLES),
  portee_clients: z.array(z.uuid()).max(1000),
});
const invalide = () => new ErreurApi("schema_invalide", "Requête invalide.");

// Une panne ou un refus de Keycloak devient un code fermé, sans détail.
function traduire(e: unknown): never {
  if (e instanceof ErreurKeycloak) {
    if (e.code === "conflit") throw new ErreurApi("identifiant_deja_pris", "Cette adresse est déjà utilisée.");
    if (e.code === "introuvable") throw new ErreurApi("introuvable", "Ressource introuvable.");
    throw new ErreurApi("porte_fermee", "Service indisponible.");
  }
  throw e;
}

export function creerServiceMembres(p: PortsMembres) {
  return {
    async lister() {
      return (await p.depot.lister()).map((m) => ({ id: m.id, role: m.role, actif: m.actif, nombreClients: m.porteeClients.length, creeLe: m.creeLe, desactiveLe: m.desactiveLe }));
    },

    async inviter(_acteur: Acteur, entree: unknown) {
      const lu = Invitation.safeParse(entree);
      if (!lu.success) throw invalide();
      const { email, role, portee_clients: portee } = lu.data;
      if (new Set(portee).size !== portee.length) throw invalide();
      // Dirigeant : aucune liste (il voit tout). Second administrateur : liste explicite non vide, jamais de portée globale (échec fermé).
      if ((role === "dirigeant") !== (portee.length === 0)) throw new ErreurApi("regle_metier", "Portée incompatible avec ce rôle.");
      try {
        if (await p.keycloak.chercherParEmail(email)) throw new ErreurApi("identifiant_deja_pris", "Cette adresse est déjà utilisée.");
        if (portee.length > 0 && !(await p.depot.clientsExistent(portee))) throw new ErreurApi("regle_metier", "Un client de la portée n'existe pas.");
        const { id: sujet } = await p.keycloak.creerUtilisateur({ email }); // (1) désactivé
        let ligne: { id: string };
        try {
          ligne = await p.depot.inserer({ sujet, role, porteeClients: portee }, _acteur.sujet); // (2)
        } catch (e) {
          // L'utilisateur reste désactivé, jamais supprimé ; rien de personnel dans la ligne de journal.
          p.journaliser(`membres inviter insertion impossible code=${String((e as { code?: unknown } | null)?.code ?? "inconnu")}`);
          throw new ErreurApi("erreur_interne", "Erreur interne.");
        }
        await p.keycloak.activer(sujet); // (3)
        let envoyee = false;
        if (p.invitationOuverte()) {
          envoyee = await p.keycloak.envoyerActions(sujet).then(() => true, () => { p.journaliser("membres inviter envoi impossible"); return false; }); // (4)
        }
        return { id: ligne.id, role, nombreClients: portee.length, invitationEnvoyee: envoyee };
      } catch (e) {
        return traduire(e);
      }
    },

    async desactiver(acteur: Acteur, membreId: string) {
      const regle: RegleDesactivation = (c) => changementMembreAutorise({ acteur, cible: c.cible, nouveau: "retrait", dirigeantsActifs: c.dirigeantsActifs });
      const r = await p.depot.desactiver({ cibleId: membreId, acteur }, regle);
      if (r.etat === "introuvable") throw new ErreurApi("introuvable", "Ressource introuvable.");
      if (r.etat === "refuse") throw new ErreurApi("regle_metier", "Désactivation refusée : ni vous-même, ni le dernier dirigeant actif.");
      // Étape Keycloak, idempotente : aussi rejouée quand la ligne était déjà désactivée (échec passé de cette étape).
      try {
        await p.keycloak.desactiver(r.sujet);
      } catch (e) {
        p.journaliser("membres desactiver keycloak impossible");
        traduire(e);
      }
    },
  };
}
export type ServiceMembres = ReturnType<typeof creerServiceMembres>;
