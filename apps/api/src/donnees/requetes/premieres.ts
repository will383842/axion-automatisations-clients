import { declarer, type RequeteDeclaree } from "./structure.js";

// Premières requêtes, déclarées en structure (aucun texte SQL) : compter les personnes, lister les listes de prospects, état des données (T2-41).
export function premieresRequetes(): Record<string, RequeteDeclaree> {
  const compterPersonnes = declarer({
    nom: "compterPersonnes", mode: "lecture", metadonnees: true, parametres: {},
    forme: { type: "simple", table: "commun.personnes", sortie: { agregats: [{ fonction: "compter", alias: "total" }] } },
  });
  const listerListesProspects = declarer({
    nom: "listerListesProspects", mode: "lecture", metadonnees: false,
    parametres: { limite: { type: "entier", min: 1, max: 200, defaut: 50 } },
    forme: { type: "simple", table: "commun.listes_prospects", sortie: { lignes: [{ colonne: "id" }, { colonne: "nom" }, { colonne: "cree_le" }] }, tri: [{ colonne: "cree_le", sens: "desc" }], limite: { parametre: "limite" } },
  });
  const etatDonnees = declarer({
    nom: "etatDonnees", mode: "lecture", metadonnees: true, parametres: {},
    forme: { type: "composee", parties: [
      { alias: "personnes", table: "commun.personnes", agregat: { fonction: "compter", alias: "personnes" } },
      { alias: "taille_fichiers", table: "commun.index_fichiers", agregat: { fonction: "somme", colonne: "taille_octets", alias: "taille_fichiers" } },
    ] },
  });
  return { compterPersonnes, listerListesProspects, etatDonnees };
}
