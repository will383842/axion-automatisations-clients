import { EcranSecurite } from "./EcranSecurite.tsx";
import { portSansPont } from "./donnees.ts";

// Sécurité et accès (T3-07d) : la page lit un port de données. Sans pont console → API d'équipe, le port rend « vide » (aucune donnée inventée).
export default function Page() {
  return <EcranSecurite donnees={portSansPont.lire()} />;
}

// États forcés par le banc de recette (src/etats/forcer.tsx).
export const etats = {
  vide: () => <EcranSecurite donnees={{ genre: "vide" }} />,
  chargement: () => <EcranSecurite donnees={{ genre: "chargement" }} />,
  erreur: () => <EcranSecurite donnees={{ genre: "erreur" }} />,
  "acces-refuse": () => <EcranSecurite donnees={{ genre: "acces-refuse" }} />,
};
