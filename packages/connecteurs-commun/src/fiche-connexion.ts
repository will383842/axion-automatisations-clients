import type { Connecteur, Garantie } from "@axion-auto/sdk-module";
import { ACTIONS } from "./capacites.ts";
import type { DeclarationConnecteur } from "./famille.ts";
import { ACTIONS_AGENDA } from "./familles/agenda.ts";
import { ACTIONS_COMPTABILITE } from "./familles/comptabilite.ts";
import { ACTIONS_CRM } from "./familles/crm.ts";
import { ACTIONS_MESSAGERIE_EQUIPE } from "./familles/messagerie-equipe.ts";
import { ACTIONS_STOCKAGE } from "./familles/stockage.ts";

// Les cinq familles ajoutées ici ; la messagerie reste déclarée dans capacites.ts.
export const FAMILLES: Record<string, readonly string[]> = {
  agenda: ACTIONS_AGENDA,
  stockage: ACTIONS_STOCKAGE,
  comptabilite: ACTIONS_COMPTABILITE,
  crm: ACTIONS_CRM,
  "messagerie-equipe": ACTIONS_MESSAGERIE_EQUIPE,
};

// Phrases fixes, une par action ; la fiche ne reprend jamais un texte venu du module.
// Une action sans phrase ne passe pas la fiche : il faut l'ajouter ici (et au catalogue de messages, T0-23).
const PHRASES: Record<string, { phrase: string; lit?: string }> = {
  "messagerie.lister_nouveaux": { phrase: "Repérer vos nouveaux messages", lit: "La liste de vos nouveaux messages" },
  "messagerie.lire": { phrase: "Lire un message", lit: "Expéditeur, objet et contenu des messages lus" },
  "messagerie.etiqueter": { phrase: "Classer un message avec une étiquette" },
  "messagerie.creer_brouillon": { phrase: "Préparer un brouillon de réponse" },
  "messagerie.envoyer": { phrase: "Envoyer un message" },
  "agenda.lister_creneaux": { phrase: "Voir vos créneaux libres", lit: "Vos créneaux libres et occupés, sans le détail des rendez-vous" },
  "agenda.creer_evenement": { phrase: "Ajouter un rendez-vous à votre agenda" },
  "stockage.lister": { phrase: "Voir la liste de vos documents", lit: "Les noms de vos documents" },
  "stockage.lire": { phrase: "Ouvrir un document", lit: "Le contenu des documents ouverts" },
  "stockage.deposer": { phrase: "Déposer un document dans un dossier" },
  "comptabilite.creer_facture_fournisseur_brouillon": { phrase: "Préparer un brouillon de facture fournisseur, à valider par vous" },
  "crm.chercher_contact": { phrase: "Chercher un contact", lit: "Nom et e-mail des contacts trouvés" },
  "crm.ajouter_contact": { phrase: "Ajouter un contact" },
  "messagerie-equipe.publier": { phrase: "Publier un message dans le canal de l'équipe" },
};

const DUREE_GARDE = "Accès de courte durée, renouvelé à chaque échange et jamais conservé par l'automatisation";

export type DemandeModule = { connecteurs: Connecteur[] };
export type LigneAction = { action: string; phrase: string; garantie: Garantie };
export type Connexion = {
  famille: string;
  outil: string;
  actions: LigneAction[];
  portees: string[];
  porteesInutiles: string[];
  donneesLues: string[];
  dureeGarde: string;
};
export type FicheConnexion = { connexions: Connexion[] };

// Même résultat pour la console et le portail : le portail affiche, il n'exécute rien.
// Seuls l'outil et les portées du connecteur (déclarés par lui, pas par le module) et les phrases fixes sortent.
export function ficheConnexion(modules: DemandeModule | DemandeModule[], connecteurs: DeclarationConnecteur[]): FicheConnexion {
  const demandes = (Array.isArray(modules) ? modules : [modules]).flatMap((m) => m.connecteurs);
  const familles = [...new Set(demandes.map((d) => d.famille))];
  const connexions = familles.map((famille): Connexion => {
    const permises = FAMILLES[famille] ?? ACTIONS[famille];
    if (!permises) throw new Error(`famille inconnue : ${famille}`);
    const duFamille = demandes.filter((d) => d.famille === famille);
    const demandees = [...new Set(duFamille.flatMap((d) => d.actions))];
    const hors = demandees.find((a) => !permises.includes(a));
    if (hors) throw new Error(`action « ${hors} » hors de la famille ${famille}`);
    const connecteur = connecteurs.find((c) => c.famille === famille);
    if (!connecteur) throw new Error(`aucun connecteur pour la famille ${famille}`);
    const actions = demandees.map((action): LigneAction => {
      const capacite = connecteur.capacites.find((c) => c.action === action);
      if (!capacite) throw new Error(`action « ${action} » non offerte par le connecteur ${famille}`);
      const phrase = PHRASES[`${famille}.${action}`]?.phrase;
      if (!phrase) throw new Error(`action « ${action} » sans phrase du catalogue`);
      return { action, phrase, garantie: capacite.garantie };
    });
    const utiles = new Set(duFamille.flatMap((d) => d.portees));
    return {
      famille,
      outil: connecteur.outil,
      actions,
      portees: connecteur.portees,
      porteesInutiles: connecteur.portees.filter((p) => !utiles.has(p)),
      donneesLues: demandees.flatMap((a) => PHRASES[`${famille}.${a}`]?.lit ?? []),
      dureeGarde: DUREE_GARDE,
    };
  });
  return { connexions };
}
