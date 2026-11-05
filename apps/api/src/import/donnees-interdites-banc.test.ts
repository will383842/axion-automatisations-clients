import { describe, expect, it } from "vitest";
import { detecter } from "./donnees-interdites.ts";

// T2-47b (audit tour 3) : les motifs COURTS ne comptent que comme mots entiers ; la garde est une AIDE (noms évidents), pas un contrôle de contenu.
const LEGITIMES = [
  // faux positifs signalés à l'audit
  "diagnostic_amiante", "diagnostic_plomb", "diagnostic_gaz", "diagnostic_termites", "diagnostics_realises", "diagnostic_electricite", "Diagnostic amiante",
  "code_insee_commune", "insee_commune", "commune_insee", "codeinsee", "code_insee_naissance", "Code INSEE commune", "departement_insee",
  "numero_compte_client", "numero_compte", "compte_bancaire_entreprise", "compte_client", "compte_comptable", "numero_compte_comptable", "compte_general",
  "pin_code_postal", "secret_defense", "tokens_utilises", "pins", "pin_parking", "lapin", "lapins", "sapins", "depin", "taliban", "password_reset_url",
  "handicap_acces_pmr", "acces_pmr", "lesecu", "dusecu", "lacb", "decb", "Pins",
  // immobilier
  "adresse1", "adresse2", "code_postal2", "ville", "surface_habitable", "nombre_pieces", "etage", "dpe_classe", "loyer_hors_charges", "charges_mensuelles", "depot_garantie", "date_etat_des_lieux",
  "type_bien", "annee_construction", "taxe_fonciere", "reference_mandat", "numero_lot", "numero_de_lot", "parcelle_cadastrale", "copropriete", "syndic_nom", "agent_commercial", "visite_virtuelle_url", "photos_url",
  // santé, bien-être
  "date_rendez_vous", "duree_seance", "type_soin", "praticien", "cabinet", "numero_adeli", "specialite", "mutuelle_nom", "tarif_seance", "seance_massage", "centre_bien_etre", "etablissement_sante", "salle_de_sport",
  "consentement_newsletter", "date_derniere_visite", "forfait_cure", "cure_thermale", "pilates", "yoga_niveau", "esthetique_soin",
  // commerce
  "reference_produit", "code_barres", "prix_unitaire_ht", "taux_tva", "stock_minimum", "fournisseur", "panier_moyen", "date_commande", "numero_commande", "numero_facture", "mode_livraison", "boutique",
  "numero_carte_fidelite", "points_fidelite", "remise_pourcentage", "categorie_produit", "marque", "bicyclette", "bicolore", "rubrique", "tribune", "cbd_huile", "cabine", "cabinet_dentaire",
  // compta
  "siren", "siret", "numero_tva", "code_ape", "forme_juridique", "capital_social", "date_cloture", "exercice_comptable", "plan_comptable", "journal_achats", "echeance_paiement", "mode_reglement", "solde_client",
  "cotisation_sociale", "regime_social", "charges_sociales", "capital_social_euros", "tiers_comptable",
  // RH
  "nom", "prenom", "date_naissance", "lieu_naissance", "poste", "service", "date_embauche", "type_contrat", "salaire_brut_mensuel", "heures_supplementaires", "conges_restants", "manager", "matricule", "numero_matricule",
  "convention_collective", "mutuelle_entreprise", "formation_suivie", "entretien_annuel", "taux_activite", "securite_travail", "responsable_securite", "securite_incendie", "secretaire", "secretariat",
  // contact / général
  "courriel", "telephone", "mobile", "civilite", "entreprise", "site_web", "commentaire", "source_contact", "date_creation", "statut", "consentement", "pinterest", "senior", "tribu", "nirvana", "libanais",
  "ribambelle", "tokenisation", "pinot_noir", "spinning", "epinal", "lapinou", "pinceau", "pingouin", "campinas", "sapin_noel", "bibliothecaire", "rebic", "cbm", "ssnack", "nssi", "ribot", "nirmal", "secundo",
  "pass_navigo", "passeport_numero", "passerelle", "mot_cle", "motif_visite", "motivation", "mots_cles", "mot_clef",
  // anglais
  "first_name", "last_name", "email", "phone_number", "company_name", "street_address", "postal_code", "created_at", "updated_at", "order_total", "customer_id", "invoice_number", "account_manager", "account_name", "business_account",
  "secure_link", "security_level", "ping_ms", "spinner",
];

describe("banc de noms LÉGITIMES (T2-47b, audit tour 3)", () => {
  it("[C-060] le banc compte au moins 150 noms légitimes", () => {
    expect(new Set(LEGITIMES).size).toBeGreaterThanOrEqual(150);
  });
  it.each([...new Set(LEGITIMES)])("[C-060] la colonne légitime « %s » passe", (colonne) => {
    expect(detecter([colonne])).toEqual([]);
  });
});

describe("garde : motifs courts en mots entiers, leet, synonymes, lettres non latines (T2-47b, audit tour 3)", () => {
  const interdits: [string, string][] = [
    ["ccnumber", "bancaire"], ["cc_number", "bancaire"], ["CCNumber", "bancaire"],
    ["p@ssword", "mot_de_passe"], ["pa55word", "mot_de_passe"], ["passw0rd", "mot_de_passe"], ["P@55w0rd", "mot_de_passe"], ["m0tdepasse", "mot_de_passe"], ["m0t_de_p4sse", "mot_de_passe"],
    ["1ban", "bancaire"], ["lban", "bancaire"], ["1BAN", "bancaire"], ["ib4n", "bancaire"], ["n1r", "securite_sociale"], ["$ecu", "securite_sociale"],
    ["motdpasse", "mot_de_passe"], ["mot_d_passe", "mot_de_passe"], ["cle_api", "mot_de_passe"], ["cle_secrete", "mot_de_passe"], ["cleApi", "mot_de_passe"], ["jeton", "mot_de_passe"], ["jeton_acces", "mot_de_passe"], ["jetons", "mot_de_passe"],
    ["num_sec_soc", "securite_sociale"], ["N° sec soc", "securite_sociale"], ["insee", "securite_sociale"], ["N° INSEE", "securite_sociale"], ["numero_insee", "securite_sociale"],
    ["medical", "sante"], ["antecedents_medicaux", "sante"], ["antecedent_medical", "sante"], ["diagnostic_medical", "sante"], ["parti_politique", "opinion"], ["casier", "infraction"],
    ["compte_bancaire", "bancaire"], ["numero_compte_bancaire", "bancaire"],
    ["ɪʙᴀɴ", "caracteres_non_latins"], ["iƅan", "caracteres_non_latins"], ["ｉｂａｎ", "bancaire"], ["汉字_ɪʙᴀɴ", "caracteres_non_latins"],
    ["ibanclient", "bancaire"], ["ribclient", "bancaire"], ["clientnir", "securite_sociale"], ["numsecuclient", "securite_sociale"], ["moncodenirfr", "securite_sociale"], ["mdpclient", "mot_de_passe"],
  ];
  it.each(interdits)("[C-060] le nom « %s » est refusé (%s)", (colonne, categorie) => {
    expect(detecter([colonne])).toEqual([{ colonne, categorie }]);
  });
  it("[C-060] des lettres françaises et latines étendues (œ, æ, ß, ø, ł, đ) ne sont pas refusées", () => {
    expect(detecter(["cœur_de_cible", "sœur", "nœud", "œuvre", "Straße", "łódź_ville", "København", "đakovo"])).toEqual([]);
  });
  it("[C-060] les chiffres légitimes en fin de nom restent des séparateurs (leet sans faux positif)", () => {
    expect(detecter(["adresse1", "code_postal2", "ligne3", "tel4", "niveau5", "ref0", "annee_2024", "taux_tva_20"])).toEqual([]);
  });
});
