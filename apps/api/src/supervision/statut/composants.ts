// Composants génériques de la page d'état (C-565). Seuls ces quatre noms sortent : jamais un client, une automatisation privée ni un hôte interne.
export const COMPOSANTS_PUBLICS = ["Console", "Portail", "Automatisations", "Messagerie"] as const;
export type ComposantPublic = (typeof COMPOSANTS_PUBLICS)[number];
export type EtatComposant = "operationnel" | "degrade" | "panne" | "inconnu";
export type EtatBrique = "haut" | "bas";

// Brique (champ « service » de ops/socle/uptime-kuma/moniteurs.json) → composant générique. Une brique absente de cette table ne figure jamais sur la page.
export const BRIQUE_VERS_COMPOSANT: Readonly<Record<string, ComposantPublic>> = {
  console: "Console",
  portail: "Portail",
  api: "Automatisations",
  greenmail: "Messagerie",
};

const RANG: Record<EtatComposant, number> = { inconnu: 0, operationnel: 1, degrade: 2, panne: 3 };
export const pire = (a: EtatComposant, b: EtatComposant): EtatComposant => (RANG[b] > RANG[a] ? b : a);

// Un composant est en panne si une de ses briques est à l'arrêt ; sans aucune mesure, il est « inconnu » (on n'affirme pas qu'il fonctionne).
export function etatsComposants(briques: Readonly<Record<string, EtatBrique>>): Record<ComposantPublic, EtatComposant> {
  const etats = Object.fromEntries(COMPOSANTS_PUBLICS.map((c) => [c, "inconnu" as EtatComposant])) as Record<ComposantPublic, EtatComposant>;
  for (const [brique, composant] of Object.entries(BRIQUE_VERS_COMPOSANT)) {
    const mesure = briques[brique];
    if (mesure === undefined) continue;
    etats[composant] = pire(etats[composant], mesure === "bas" ? "panne" : "operationnel");
  }
  return etats;
}

export const estComposantPublic = (v: unknown): v is ComposantPublic => (COMPOSANTS_PUBLICS as readonly unknown[]).includes(v);
