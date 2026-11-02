// T2-47 : liste FERMÉE des motifs de colonnes interdites à l'import, par catégorie. Écrits déjà normalisés (minuscules, sans accents, mots séparés par `_`).
// Un ajout se relit : un motif trop court ou trop courant bloquerait des fichiers légitimes.
export const CATEGORIES = ["sante", "securite_sociale", "bancaire", "mot_de_passe", "opinion", "infraction"] as const;
export type Categorie = (typeof CATEGORIES)[number];

export const MOTIFS: Readonly<Record<Categorie, readonly string[]>> = {
  sante: ["sante", "maladie", "pathologie", "diagnostic", "handicap", "groupe_sanguin", "arret_maladie", "traitement_medical", "dossier_medical"],
  securite_sociale: ["numero_securite_sociale", "securite_sociale", "num_secu", "numero_secu", "nir"],
  bancaire: ["iban", "rib", "numero_carte", "carte_bancaire", "cvv", "cryptogramme"],
  mot_de_passe: ["mot_de_passe", "password", "passwd", "mdp"],
  opinion: ["opinion_politique", "religion", "appartenance_syndicale", "orientation_sexuelle", "origine_ethnique"],
  infraction: ["casier_judiciaire", "condamnation", "infraction"],
};
