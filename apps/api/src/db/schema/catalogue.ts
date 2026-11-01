import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgEnum, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tableCommune } from "./aides.ts";

// Catalogue commun (C5, lot 2) : la seule partie partagée par tous les clients (ADR 0051). Aucune table n'a de tenant_id.
// Vocabulaires provisoires : une valeur s'ajoute plus tard (additif), jamais ne se renomme. Aucun prix réel ici ni dans les fixtures.
export const visibiliteAutomatisation = pgEnum("visibilite_automatisation", ["interne", "visible_clients"]);
export const origineAutomatisation = pgEnum("origine_automatisation", ["axion", "client", "partenaire"]);
// Règlement européen sur l'IA ; « sans_ia » et le nul sont permis : aucune automatisation n'est obligée d'utiliser une IA (A-159).
export const niveauRisqueIa = pgEnum("niveau_risque_ia", ["sans_ia", "minimal", "limite", "eleve", "inacceptable"]);
// Statut de l'AUTOMATISATION (C-672), jamais confondu avec le statut de version.
export const statutAutomatisation = pgEnum("statut_automatisation", ["idee", "en_construction", "au_catalogue", "archivee"]);
// Statut de VERSION : les six états de A-305, mêmes mots à l'écran et en base.
export const statutVersion = pgEnum("statut_version", ["brouillon", "recette", "pilote", "publiee", "depreciee", "retiree"]);
export const natureVersion = pgEnum("nature_version", ["creation", "correctif", "evolution", "rupture"]);
export const statutPrereglage = pgEnum("statut_prereglage", ["brouillon", "publie", "retire"]);
export const familleConnecteur = pgEnum("famille_connecteur", ["messagerie", "agenda", "crm", "comptabilite", "stockage", "signature", "telephonie", "autre"]);

const HEX64 = "^[0-9a-f]{64}$";
const SEMVER = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$";
const cle = <T>(nom: string, t: Record<string, T>) => t[nom] as never;

// Métiers et postes (C-670) : des TABLES de référence, pas des énumérations ; le dirigeant en ajoute, renomme, regroupe sans migration. Jamais supprimés : `actif = faux`.
const referentiel = (nom: string) =>
  tableCommune(
    nom,
    {
      id: uuid("id").primaryKey().defaultRandom(),
      code: text("code").notNull(),
      nom: text("nom").notNull(),
      groupe: text("groupe").notNull(),
      ordre: integer("ordre").notNull(),
      actif: boolean("actif").notNull().default(true),
    },
    (t) => [
      unique(`${nom}_code_unique`).on(cle("code", t)),
      check(`${nom}_code_format`, sql`${t["code"]} ~ '^[a-z][a-z0-9_]{1,62}$'`),
      check(`${nom}_nom_non_vide`, sql`length(btrim(${t["nom"]})) > 0`),
    ],
  );
export const metiers = referentiel("metiers");
export const postes = referentiel("postes");

// Automatisation (A-122) : le code est stable, lisible et jamais réutilisé (C-685). Pas de colonne « métiers visés » (étiquettes ci-dessous), pas d'étape de construction (statut).
export const automatisations = tableCommune(
  "automatisations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    nom: text("nom").notNull(),
    fonction: text("fonction"),
    description: text("description"),
    visibilite: visibiliteAutomatisation("visibilite").notNull().default("interne"),
    priorite: integer("priorite").notNull().default(0),
    minutesGagnees: integer("minutes_gagnees"),
    origine: origineAutomatisation("origine").notNull().default("axion"),
    niveauRisqueIa: niveauRisqueIa("niveau_risque_ia"),
    statut: statutAutomatisation("statut").notNull().default("idee"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("automatisations_code_unique").on(cle("code", t)),
    check("automatisations_code_format", sql`${t["code"]} ~ '^[A-Z]{2,6}-[0-9]{3,5}$'`),
    check("automatisations_nom_non_vide", sql`length(btrim(${t["nom"]})) > 0`),
    check("automatisations_fonction_courte", sql`${t["fonction"]} IS NULL OR length(${t["fonction"]}) <= 200`),
    check("automatisations_minutes_gagnees_positives", sql`${t["minutesGagnees"]} IS NULL OR ${t["minutesGagnees"]} >= 0`),
    index("automatisations_statut_idx").on(cle("statut", t)),
    index("automatisations_visibilite_idx").on(cle("visibilite", t)),
    index("automatisations_nom_idx").on(cle("nom", t)),
    index("automatisations_priorite_idx").on(cle("priorite", t)),
  ],
);

// Étiquettes multiples (C-671) : l'étiquette « outil » n'est jamais saisie, elle se calcule dans la vue automatisation_outils (migration).
export const automatisationMetiers = tableCommune(
  "automatisation_metiers",
  {
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
    metierId: uuid("metier_id").notNull().references(() => metiers.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [cle("automatisationId", t), cle("metierId", t)] }), index("automatisation_metiers_metier_automatisation_idx").on(cle("metierId", t), cle("automatisationId", t))],
);
export const automatisationPostes = tableCommune(
  "automatisation_postes",
  {
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
    posteId: uuid("poste_id").notNull().references(() => postes.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [cle("automatisationId", t), cle("posteId", t)] }), index("automatisation_postes_poste_automatisation_idx").on(cle("posteId", t), cle("automatisationId", t))],
);

// Version d'automatisation (A-123, A-124) : immuable une fois publiée (déclencheur de la migration). T4-25 écrit ici et n'en crée aucune autre.
export const versionsAutomatisation = tableCommune(
  "versions_automatisation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
    semver: text("semver").notNull(),
    apiMoteur: text("api_moteur").notNull(),
    artefactRef: text("artefact_ref").notNull(),
    empreinteSha256: text("empreinte_sha256").notNull(),
    signatureEd25519: text("signature_ed25519").notNull(),
    sbomRef: text("sbom_ref").notNull(),
    nature: natureVersion("nature").notNull().default("evolution"),
    schemaConfiguration: jsonb("schema_configuration").notNull().default(sql`'{}'::jsonb`),
    // Connecteurs déclarés par le manifeste (A-294) : { connecteurs: [{ famille, outil }] }. Sert à calculer l'étiquette « outil ».
    manifeste: jsonb("manifeste").notNull().default(sql`'{}'::jsonb`),
    migration: text("migration"),
    notes: text("notes"),
    statut: statutVersion("statut").notNull().default("brouillon"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("versions_automatisation_automatisation_id_semver_unique").on(cle("automatisationId", t), cle("semver", t)),
    unique("versions_automatisation_empreinte_sha256_unique").on(cle("empreinteSha256", t)),
    check("versions_automatisation_empreinte_format", sql`${t["empreinteSha256"]} ~ '${sql.raw(HEX64)}'`),
    check("versions_automatisation_semver_format", sql`${t["semver"]} ~ '${sql.raw(SEMVER)}'`),
    check("versions_automatisation_signature_non_vide", sql`length(btrim(${t["signatureEd25519"]})) > 0`),
    index("versions_automatisation_automatisation_idx").on(cle("automatisationId", t), cle("statut", t)),
  ],
);

// Préréglage de métier (A-137, C-673, C-674) : naît en brouillon ; « seul le dirigeant publie » est appliqué côté serveur (T4-60), pas ici.
// Les données ne portent jamais d'identifiant, d'e-mail ni de SIREN de client (CHECK de la migration).
export const prereglagesMetier = tableCommune(
  "prereglages_metier",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
    metierId: uuid("metier_id").notNull().references(() => metiers.id, { onDelete: "restrict" }),
    donnees: jsonb("donnees").notNull(),
    version: integer("version").notNull(),
    statut: statutPrereglage("statut").notNull().default("brouillon"),
    auteur: text("auteur").notNull(),
    // Pourquoi ce changement (nommé ainsi : une colonne « motif » devrait être une énumération, invariant C5 n° 5).
    justification: text("justification").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
    versionPrecedenteId: uuid("version_precedente_id"),
    // Plage de versions du module que le préréglage sert (la règle de revalidation est écrite en T4-60).
    moduleVersionMin: text("module_version_min"),
    moduleVersionMax: text("module_version_max"),
  },
  (t) => [
    unique("prereglages_metier_automatisation_id_metier_id_version_unique").on(cle("automatisationId", t), cle("metierId", t), cle("version", t)),
    foreignKey({ name: "prereglages_metier_version_precedente_fk", columns: [cle("versionPrecedenteId", t)], foreignColumns: [cle("id", t)] }).onDelete("restrict"),
    check("prereglages_metier_version_positive", sql`${t["version"]} >= 1`),
    check("prereglages_metier_auteur_non_vide", sql`length(btrim(${t["auteur"]})) > 0`),
    check("prereglages_metier_justification_non_vide", sql`length(btrim(${t["justification"]})) > 0`),
    check("prereglages_metier_donnees_objet", sql`jsonb_typeof(${t["donnees"]}) = 'object'`),
    // Filtre volontairement large, quitte à refuser un faux positif : toute clé qui CONTIENT un de ces mots, toute adresse e-mail, tout nombre de 9 ou 14 chiffres (SIREN, SIRET).
    // Le schéma Zod d'écriture (attaque 5 de la fiche) est livré par T4-60, qui écrit les préréglages.
    check(
      "prereglages_metier_donnees_sans_client",
      sql`${t["donnees"]}::text !~* '"[^"]*(tenant|client|organisation|instance|mail|courriel|t[eé]l[eé]phone|phone|siren|siret|iban)[^"]*"[[:space:]]*:' AND ${t["donnees"]}::text !~* '[^"[:space:]@]+@[^"[:space:]@]+\\.[a-z]{2,}' AND ${t["donnees"]}::text !~ '(^|[^0-9])([0-9]{9}|[0-9]{14})([^0-9]|$)'`,
    ),
    index("prereglages_metier_metier_idx").on(cle("metierId", t), cle("automatisationId", t)),
    index("prereglages_metier_automatisation_idx").on(cle("automatisationId", t), cle("statut", t)),
  ],
);

// Synonymes simples de la recherche (B-533) : créés ici car T3-40 n'a pas le droit de migrer.
export const synonymesCatalogue = tableCommune(
  "synonymes_catalogue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mot: text("mot").notNull(),
    equivalent: text("equivalent").notNull(),
  },
  (t) => [
    unique("synonymes_catalogue_mot_equivalent_unique").on(cle("mot", t), cle("equivalent", t)),
    check("synonymes_catalogue_non_vides", sql`length(btrim(${t["mot"]})) > 0 AND length(btrim(${t["equivalent"]})) > 0 AND ${t["mot"]} <> ${t["equivalent"]}`),
  ],
);

// Pack (A-139) : prix en centimes entiers ; un prix ne se modifie pas (console_equipe ne change que « actif »), on crée un autre pack.
export const packs = tableCommune(
  "packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nom: text("nom").notNull(),
    metierId: uuid("metier_id").notNull().references(() => metiers.id, { onDelete: "restrict" }),
    prixCentimes: bigint("prix_centimes", { mode: "number" }).notNull(),
    actif: boolean("actif").notNull().default(true),
    // Qui a fixé ce prix (relecture de T2-03) : l'argent a toujours un auteur.
    auteur: text("auteur").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("packs_nom_unique").on(cle("nom", t)),
    check("packs_prix_positif", sql`${t["prixCentimes"]} >= 0`),
    check("packs_nom_non_vide", sql`length(btrim(${t["nom"]})) > 0`),
    check("packs_auteur_non_vide", sql`length(btrim(${t["auteur"]})) > 0`),
  ],
);
export const packsAutomatisations = tableCommune(
  "packs_automatisations",
  {
    packId: uuid("pack_id").notNull().references(() => packs.id, { onDelete: "restrict" }),
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [cle("packId", t), cle("automatisationId", t)] }), index("packs_automatisations_automatisation_idx").on(cle("automatisationId", t))],
);

// Connecteur (A-141) : identité figée (ajout seul).
export const connecteurs = tableCommune(
  "connecteurs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    famille: familleConnecteur("famille").notNull(),
    outil: text("outil").notNull(),
    version: text("version").notNull(),
    capacites: jsonb("capacites").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    unique("connecteurs_famille_outil_version_unique").on(cle("famille", t), cle("outil", t), cle("version", t)),
    check("connecteurs_capacites_liste", sql`jsonb_typeof(${t["capacites"]}) = 'array'`),
  ],
);

// Grille de prix (A-142) : AJOUT SEUL, la ligne en vigueur est la plus récente ; argent en centimes entiers ; l'auteur est toujours connu.
export const grillesPrix = tableCommune(
  "grilles_prix",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
    formulesActives: jsonb("formules_actives").notNull(),
    montantInstallationCentimes: bigint("montant_installation_centimes", { mode: "number" }).notNull(),
    montantMensuelCentimes: bigint("montant_mensuel_centimes", { mode: "number" }).notNull(),
    maintenanceIncluseMois: integer("maintenance_incluse_mois").notNull(),
    maintenanceEnsuiteCentimes: bigint("maintenance_ensuite_centimes", { mode: "number" }).notNull(),
    auteur: text("auteur").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("grilles_prix_montants_positifs", sql`${t["montantInstallationCentimes"]} >= 0 AND ${t["montantMensuelCentimes"]} >= 0 AND ${t["maintenanceEnsuiteCentimes"]} >= 0`),
    check("grilles_prix_maintenance_mois_positifs", sql`${t["maintenanceIncluseMois"]} >= 0`),
    check("grilles_prix_auteur_non_vide", sql`length(btrim(${t["auteur"]})) > 0`),
    check("grilles_prix_formules_liste", sql`jsonb_typeof(${t["formulesActives"]}) = 'array'`),
    index("grilles_prix_automatisation_idx").on(cle("automatisationId", t), cle("creeLe", t)),
  ],
);
