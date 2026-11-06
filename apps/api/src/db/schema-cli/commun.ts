import { sql } from "drizzle-orm";
import { bigint, check, customType, foreignKey, index, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Schéma `commun` d'une base de client (T2-32, ADR 0046). Une base par client : aucune colonne de client ici, et pas de RLS (B-173) :
// le filtre « par établissement » est imposé par le service des données (T2-37), la colonne est seulement obligatoire.
// Les e-mails et téléphones sont chiffrés par la clé du client (T2-33) : `<champ>_chiffre` (bytea) et `<champ>_empreinte` (bytea) pour la recherche.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const MAX_TEXTE = 500;
const EMPREINTE_OCTETS = 32; // empreinte SHA-256 : exactement 32 octets
const empreinteValide = (nom: string, colonne: string, nullable: boolean) => check(`${nom}_taille`, sql.raw(`${nullable ? `"${colonne}" IS NULL OR ` : ""}octet_length("${colonne}") = ${EMPREINTE_OCTETS}`));
const borne = (nom: string, colonne: string) => check(`${nom}_longueur`, sql.raw(`char_length("${colonne}") <= ${MAX_TEXTE}`));

export const commun = pgSchema("commun");

export const etablissements = commun.table(
  "etablissements",
  { id: uuid("id").primaryKey().defaultRandom(), nom: text("nom").notNull(), creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow() },
  (t) => [borne("etablissements_nom", t.nom.name)],
);

export const entreprises = commun.table(
  "entreprises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    raisonSociale: text("raison_sociale").notNull(),
    siren: text("siren"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [borne("entreprises_raison", t.raisonSociale.name), check("entreprises_siren_forme", sql`${t.siren} IS NULL OR ${t.siren} ~ '^[0-9]{9}$'`)],
);

export const personnes = commun.table(
  "personnes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    etablissementId: uuid("etablissement_id").notNull(),
    entrepriseId: uuid("entreprise_id"),
    nom: text("nom").notNull(),
    prenom: text("prenom"),
    courrielChiffre: bytea("courriel_chiffre"),
    courrielEmpreinte: bytea("courriel_empreinte"),
    telephoneChiffre: bytea("telephone_chiffre"),
    telephoneEmpreinte: bytea("telephone_empreinte"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "personnes_etablissement_fk", columns: [t.etablissementId], foreignColumns: [etablissements.id] }),
    foreignKey({ name: "personnes_entreprise_fk", columns: [t.entrepriseId], foreignColumns: [entreprises.id] }),
    index("personnes_courriel_empreinte_idx").on(t.etablissementId, t.courrielEmpreinte),
    index("personnes_telephone_empreinte_idx").on(t.etablissementId, t.telephoneEmpreinte),
    borne("personnes_nom", t.nom.name),
    borne("personnes_prenom", t.prenom.name),
    empreinteValide("personnes_courriel_empreinte", t.courrielEmpreinte.name, true),
    empreinteValide("personnes_telephone_empreinte", t.telephoneEmpreinte.name, true),
  ],
);

export const listesProspects = commun.table(
  "listes_prospects",
  { id: uuid("id").primaryKey().defaultRandom(), etablissementId: uuid("etablissement_id").notNull(), nom: text("nom").notNull(), creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow() },
  (t) => [foreignKey({ name: "listes_prospects_etablissement_fk", columns: [t.etablissementId], foreignColumns: [etablissements.id] }), borne("listes_prospects_nom", t.nom.name)],
);

export const listesProspectsPersonnes = commun.table(
  "listes_prospects_personnes",
  // Sortir quelqu'un d'une liste : on marque `retire_le`, on ne supprime jamais la ligne (aucun DELETE accordé).
  { listeId: uuid("liste_id").notNull(), personneId: uuid("personne_id").notNull(), retireLe: timestamp("retire_le", { withTimezone: true }) },
  (t) => [
    primaryKey({ columns: [t.listeId, t.personneId] }),
    foreignKey({ name: "lpp_liste_fk", columns: [t.listeId], foreignColumns: [listesProspects.id] }),
    foreignKey({ name: "lpp_personne_fk", columns: [t.personneId], foreignColumns: [personnes.id] }),
  ],
);

// Liste d'exclusion : seulement des empreintes, jamais l'adresse ni le numéro. Une opposition ne s'efface jamais : ajout seul pour l'application (ni UPDATE ni DELETE).
export const exclusions = commun.table(
  "exclusions",
  { id: uuid("id").primaryKey().defaultRandom(), genre: text("genre").notNull(), empreinte: bytea("empreinte").notNull(), creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow() },
  (t) => [unique("exclusions_genre_empreinte_unique").on(t.genre, t.empreinte), check("exclusions_genre", sql`${t.genre} IN ('courriel', 'telephone')`), empreinteValide("exclusions_empreinte", t.empreinte.name, false)],
);

// Index des fichiers : la clé d'objet, l'empreinte, la taille et le type ; jamais le fichier lui-même.
export const indexFichiers = commun.table(
  "index_fichiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    etablissementId: uuid("etablissement_id").notNull(),
    cleObjet: text("cle_objet").notNull(),
    empreinte: text("empreinte").notNull(),
    tailleOctets: bigint("taille_octets", { mode: "number" }).notNull(),
    typeContenu: text("type_contenu").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "index_fichiers_etablissement_fk", columns: [t.etablissementId], foreignColumns: [etablissements.id] }),
    unique("index_fichiers_cle_unique").on(t.etablissementId, t.cleObjet),
    check("index_fichiers_taille", sql`${t.tailleOctets} BETWEEN 0 AND 9007199254740991`),
    borne("index_fichiers_cle", t.cleObjet.name),
    borne("index_fichiers_type", t.typeContenu.name),
    check("index_fichiers_empreinte_forme", sql`${t.empreinte} ~ '^[0-9a-f]{64}$'`),
  ],
);
