// Navigation de la console (A-003, B-001) : 7 entrées, bloc du compte, 5 onglets sur téléphone.
// Deux niveaux : pilotage global (/alertes) et pilotage d'un client (/clients/<id>/alertes).
export interface EntreeMenu { id: string; libelle: string; href: string }
export type Niveau = { niveau: "global" } | { niveau: "client"; clientId: string };

export const ENTREES: EntreeMenu[] = [
  { id: "accueil", libelle: "Accueil", href: "/accueil" },
  { id: "clients", libelle: "Clients", href: "/clients" },
  { id: "alertes", libelle: "Alertes", href: "/alertes" },
  { id: "demandes", libelle: "Demandes", href: "/demandes" },
  { id: "facturation", libelle: "Facturation", href: "/facturation" },
  { id: "catalogue", libelle: "Catalogue et prix", href: "/catalogue" },
  { id: "conformite", libelle: "Conformité", href: "/conformite" },
];
export const COMPTE: EntreeMenu = { id: "securite", libelle: "Sécurité et accès", href: "/securite" };
export const ONGLETS = [["accueil", "Accueil"], ["clients", "Clients"], ["alertes", "Alertes"], ["demandes", "Demandes"], ["plus", "Plus"]] as const;

const CLIENT = /^\/clients\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/;
export function niveauDe(chemin: string): Niveau {
  const id = CLIENT.exec(chemin)?.[1];
  return id ? { niveau: "client", clientId: id } : { niveau: "global" };
}

// Par client : même menu, chaque lien reste dans l'espace du client (l'accueil du client est sa fiche).
export function entreesPour(n: Niveau): EntreeMenu[] {
  if (n.niveau === "global") return ENTREES;
  const base = `/clients/${n.clientId}`;
  return ENTREES.map((e) => ({ ...e, href: e.id === "accueil" ? base : `${base}${e.href}` }));
}

export function actifDe(chemin: string): string | undefined {
  const section = chemin.split(/[?#]/)[0]?.split("/").filter(Boolean)[0];
  if (!section) return "accueil";
  return ENTREES.find((e) => e.id === section)?.id;
}
