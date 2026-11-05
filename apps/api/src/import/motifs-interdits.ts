// T2-47 : liste FERMÉE des motifs de colonnes interdites à l'import, par catégorie. Écrits déjà normalisés (minuscules, sans accents, mots séparés par `_`,
// sans petits mots vides : de, du, des, d, n, no, num). Le pluriel en « s » est accepté à la comparaison. Un ajout se relit : un motif trop court ou trop courant bloquerait des fichiers légitimes.
export const CATEGORIES = ["sante", "securite_sociale", "bancaire", "mot_de_passe", "opinion", "infraction", "caracteres_non_latins"] as const;
export type Categorie = (typeof CATEGORIES)[number];

export const MOTIFS: Readonly<Record<Categorie, readonly string[]>> = {
  sante: ["sante", "maladie", "pathologie", "diagnostic_medical", "medical", "medicaux", "antecedent_medical", "antecedent_medicaux", "handicap", "groupe_sanguin", "arret_maladie", "traitement_medical", "dossier_medical", "allergie", "medecin_traitant", "ordonnance"],
  securite_sociale: ["numero_securite_sociale", "securite_sociale", "secu", "numero_secu", "insee", "numero_insee", "sec_soc", "carte_vitale", "nir", "numsecu", "ssn", "social_security_number", "social_security", "nss", "n_ss", "num_ss", "numero_ss"],
  bancaire: ["iban", "rib", "numero_carte_bancaire", "carte_bancaire", "cvv", "cvc", "cryptogramme", "bic", "swift", "credit_card", "card_number", "bank_account", "account_number", "numero_compte_bancaire", "compte_bancaire", "cc_number", "ccnumber", "cardnumber", "lban", "coordonnees_bancaires", "releve_identite_bancaire", "numero_cb", "num_cb", "cb"],
  mot_de_passe: ["mot_passe", "motdepasse", "motdpasse", "cle_api", "clef_api", "cle_secrete", "cle_privee", "jeton", "apikey", "codepin", "password", "passwd", "mdp", "pwd", "code_pin", "pin", "secret", "token", "api_key", "access_token"],
  opinion: ["opinion_politique", "parti_politique", "religion", "appartenance_syndicale", "syndicat", "syndical", "confession", "orientation_sexuelle", "origine_ethnique", "origine_raciale"],
  infraction: ["casier_judiciaire", "casier", "condamnation", "infraction"],
  caracteres_non_latins: [],
};

// Noms exacts (après normalisation) qui contiennent un motif sans être une donnée interdite. Comparaison sur le nom entier : une colonne plus longue reste repérée.
export const EXCEPTIONS: readonly string[] = ["etablissement_sante", "professionnel_sante", "secteur_sante", "diagnostic_energetique", "carte_grise", "carte_fidelite", "date_diagnostic", "code_insee", "numero_carte", "numero_carte_client", "numero_carte_fidelite", "code_commune_insee", "diagnostic_performance_energetique", "pays_liban", "liban", "ibanez",
  "pin_code_postal", "pin_parking", "secret_defense", "tokens_utilises", "password_reset_url", "handicap_acces_pmr", "acces_handicape", "centre_medical", "cabinet_medical", "materiel_medical", "equipement_medical", "secteur_medical", "numero_compte_client", "compte_bancaire_entreprise"];

// Petits mots ignorés avant la comparaison par mots (« numéro de sécu », « N° sécu », « num sécu »).
export const MOTS_VIDES: readonly string[] = ["de", "du", "des", "d", "n", "no", "num"];

// Motifs assez rares pour être repérés aussi en début ou en fin d'un nom collé, avec n'importe quoi à côté (« ibanclient », « clientmdp »). Les autres motifs courts (« rib », « nir », « secu », « pin »…)
// ne sont repérés collés que si le reste du mot se découpe en AFFIXES connus (« ribclient », « moncodenirfr ») : « tribu », « senior », « pinterest » passent.
export const COLLES: readonly string[] = ["iban"];

// Mots qui s'accolent à un motif dans un nom collé (liste fermée, plus de deux lettres).
export const AFFIXES: readonly string[] = [
  "client", "mon", "ma", "mes", "code", "numero", "num", "perso", "pro", "titulaire", "contact", "prospect", "user", "utilisateur", "new", "old", "my", "the", "nouveau", "ancien", "data", "valeur", "value", "champ", "field", "texte", "text", "saisi", "clair", "fr", "id",
];

// Lettres grecques et cyrilliques qui ressemblent à une lettre latine (NFKD ne les remplace pas) : paires « confusable → latin ». Autre lettre non latine : elle sépare les mots.
export const CONFUSABLES: Readonly<Record<string, string>> = Object.fromEntries(
  "ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX αa ιi κk νv οo ρp υu ςs АA ВB СC ЕE НH ІI ЈJ КK МM ОO РP ЅS ТT УY ХX аa вb сc еe нh іi јj кk мm оo рp ѕs тt уy хx ԁd ԛq ԝw ӏl һh ıi".split(" ").map((p) => [p[0] as string, p[1] as string]),
);

// Motifs qui ne comptent que si le nom entier (petits mots vides retirés) est exactement ce motif : « insee » seul est le NIR, « code_insee_commune » est un code commune ;
// « compte_bancaire » seul est une donnée de personne, « compte_bancaire_entreprise » non.
export const ENTIER_SEUL: readonly string[] = ["insee", "compte_bancaire"];

// Motifs courts dont le pluriel est un autre mot (« pins » = badges) : ni « s » final ni découpage avec « s ».
export const SANS_PLURIEL: readonly string[] = ["pin"];

// Écriture « leet » : lue en plus du nom brut (« p@ssw0rd », « 1ban »). Les chiffres restent des séparateurs dans le nom brut (« adresse1 »).
export const LEET: Readonly<Record<string, string>> = { "@": "a", "5": "s", "0": "o", "1": "i", "3": "e", "4": "a", $: "s" };

// Lettres latines que NFKD ne décompose pas : remplacées avant le contrôle des lettres non latines (« cœur », « Straße »).
export const LATINES_ETENDUES: Readonly<Record<string, string>> = { œ: "oe", Œ: "OE", æ: "ae", Æ: "AE", ß: "ss", ø: "o", Ø: "O", ł: "l", Ł: "L", đ: "d", Đ: "D", þ: "th", Þ: "TH", ð: "d", Ð: "D" };
