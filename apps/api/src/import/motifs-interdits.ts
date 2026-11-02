// T2-47 : liste FERMÉE des motifs de colonnes interdites à l'import, par catégorie. Écrits déjà normalisés (minuscules, sans accents, mots séparés par `_`,
// sans petits mots vides : de, du, des, d, n, no, num). Le pluriel en « s » est accepté à la comparaison. Un ajout se relit : un motif trop court ou trop courant bloquerait des fichiers légitimes.
export const CATEGORIES = ["sante", "securite_sociale", "bancaire", "mot_de_passe", "opinion", "infraction"] as const;
export type Categorie = (typeof CATEGORIES)[number];

export const MOTIFS: Readonly<Record<Categorie, readonly string[]>> = {
  sante: ["sante", "maladie", "pathologie", "diagnostic", "handicap", "groupe_sanguin", "arret_maladie", "traitement_medical", "dossier_medical", "allergie", "medecin_traitant", "ordonnance"],
  securite_sociale: ["numero_securite_sociale", "securite_sociale", "secu", "numero_secu", "insee", "numero_insee", "carte_vitale", "nir"],
  bancaire: ["iban", "rib", "numero_carte_bancaire", "carte_bancaire", "cvv", "cryptogramme"],
  mot_de_passe: ["mot_passe", "password", "passwd", "mdp", "pwd", "code_pin"],
  opinion: ["opinion_politique", "religion", "appartenance_syndicale", "syndicat", "syndical", "confession", "orientation_sexuelle", "origine_ethnique", "origine_raciale"],
  infraction: ["casier_judiciaire", "condamnation", "infraction"],
};

// Noms exacts (après normalisation) qui contiennent un motif sans être une donnée interdite. Comparaison sur le nom entier : une colonne plus longue reste repérée.
export const EXCEPTIONS: readonly string[] = ["etablissement_sante", "professionnel_sante", "secteur_sante", "diagnostic_energetique", "carte_grise", "carte_fidelite", "date_diagnostic", "code_insee", "numero_carte", "numero_carte_client", "numero_carte_fidelite"];

// Petits mots ignorés avant la comparaison par mots (« numéro de sécu », « N° sécu », « num sécu »).
export const MOTS_VIDES: readonly string[] = ["de", "du", "des", "d", "n", "no", "num"];
