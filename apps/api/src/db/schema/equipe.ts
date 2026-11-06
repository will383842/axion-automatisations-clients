import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, jsonb, pgEnum, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tableClient, tableCommune } from "./aides.ts";
import { organisations } from "./clients.ts";

// Équipe, absences, vues enregistrées et faits ignorés de « Aujourd'hui » (T3-05a, ADR 0115, migration 0020). AJOUT SEUL : rien de lot 2 n'est renommé ni retiré.
// Les trois tables communes sont lues et écrites par console_equipe SEUL (la portée d'un membre et les filtres d'une vue citent des clients) ; aucun DELETE.
// Un membre n'est jamais supprimé : désactivé, il reste lisible dans l'historique. Aucun texte libre : champs bornés par un motif ou par char_length.
export const roleMembreEquipe = pgEnum("role_membre_equipe", ["dirigeant", "second_administrateur"]);
export const natureAbsence = pgEnum("nature_absence", ["annoncee", "constatee"]);
export const motifIgnore = pgEnum("motif_ignore", ["deja_traite", "sans_objet", "reporte", "autre"]);

const nonVide = (c: unknown) => sql`length(btrim(${c})) > 0`;
const borne = (c: unknown, max: number) => sql`char_length(${c}) <= ${sql.raw(String(max))}`;
const CODE = "^[a-z][a-z0-9_.-]{0,63}$";

export const membresEquipe = tableCommune(
  "membres_equipe",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Sujet Keycloak = acteur des requêtes (app.acteur) ; unique.
    sujet: text("sujet").notNull(),
    role: roleMembreEquipe("role").notNull(),
    // Portée : liste vide = tout. Identifiants de clients et d'automatisations (jamais lisibles par console_app).
    porteeClients: uuid("portee_clients").array().notNull().default(sql`'{}'`),
    porteeAutomatisations: uuid("portee_automatisations").array().notNull().default(sql`'{}'`),
    actif: boolean("actif").notNull().default(true),
    desactiveLe: timestamp("desactive_le", { withTimezone: true }),
    desactivePar: text("desactive_par"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("membres_equipe_sujet_unique").on(t["sujet"] as never),
    check("membres_equipe_sujet_forme", sql`${t["sujet"]} ~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$'`),
    check("membres_equipe_desactivation", sql`${t["actif"]} = (${t["desactiveLe"]} IS NULL) AND (${t["desactiveLe"]} IS NULL) = (${t["desactivePar"]} IS NULL)`),
    check("membres_equipe_desactive_par_borne", sql`${t["desactivePar"]} IS NULL OR (${nonVide(t["desactivePar"])} AND ${borne(t["desactivePar"], 200)})`),
    check("membres_equipe_portees_bornees", sql`cardinality(${t["porteeClients"]}) <= 1000 AND cardinality(${t["porteeAutomatisations"]}) <= 1000`),
  ],
);

export const absences = tableCommune(
  "absences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    membreId: uuid("membre_id").notNull().references(() => membresEquipe.id, { onDelete: "restrict" }),
    debut: timestamp("debut", { withTimezone: true }).notNull(),
    fin: timestamp("fin", { withTimezone: true }),
    nature: natureAbsence("nature").notNull(),
    ouvertePar: text("ouverte_par").notNull(),
    fermeePar: text("fermee_par"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("absences_periode", sql`${t["fin"]} IS NULL OR ${t["fin"]} > ${t["debut"]}`),
    check("absences_fermeture", sql`(${t["fin"]} IS NULL) = (${t["fermeePar"]} IS NULL)`),
    check("absences_ouverte_par_borne", sql`${nonVide(t["ouvertePar"])} AND ${borne(t["ouvertePar"], 200)}`),
    check("absences_fermee_par_borne", sql`${t["fermeePar"]} IS NULL OR (${nonVide(t["fermeePar"])} AND ${borne(t["fermeePar"], 200)})`),
    uniqueIndex("absences_une_ouverte_par_membre").on(t["membreId"] as never).where(sql`${t["fin"]} IS NULL`),
    index("absences_membre_debut_idx").on(t["membreId"] as never, t["debut"] as never),
  ],
);

// Vue enregistrée : propriétaire = un membre, non partagée en V1 (B-076 en V2). Filtres : objet JSON borné à 4000 octets, version du schéma de filtres.
export const vuesEnregistrees = tableCommune(
  "vues_enregistrees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proprietaireId: uuid("proprietaire_id").notNull().references(() => membresEquipe.id, { onDelete: "restrict" }),
    ecran: text("ecran").notNull(),
    nom: text("nom").notNull(),
    filtres: jsonb("filtres").notNull(),
    versionSchema: smallint("version_schema").notNull().default(1),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
    modifieeLe: timestamp("modifiee_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("vues_enregistrees_proprietaire_nom_unique").on(t["proprietaireId"] as never, t["ecran"] as never, t["nom"] as never),
    check("vues_enregistrees_ecran_code", sql`${t["ecran"]} ~ '${sql.raw(CODE)}'`),
    check("vues_enregistrees_nom_borne", sql`${nonVide(t["nom"])} AND ${borne(t["nom"], 80)}`),
    check("vues_enregistrees_filtres_objet", sql`jsonb_typeof(${t["filtres"]}) = 'object' AND octet_length(${t["filtres"]}::text) <= 4000`),
    check("vues_enregistrees_version_positive", sql`${t["versionSchema"]} >= 1`),
  ],
);

// Fait « Aujourd'hui » ignoré pour un jour (PAR CLIENT) : rétabli, jamais effacé. `reference` est un pointeur, jamais un texte.
export const aujourdhuiIgnores = tableClient(
  "aujourdhui_ignores",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    typeFait: text("type_fait").notNull(),
    reference: text("reference").notNull(),
    jour: date("jour").notNull(),
    motif: motifIgnore("motif"),
    membre: text("membre").notNull(),
    retabliLe: timestamp("retabli_le", { withTimezone: true }),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "aujourdhui_ignores_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      unique("aujourdhui_ignores_fait_jour_unique").on(t["tenantId"] as never, t["typeFait"] as never, t["reference"] as never, t["jour"] as never),
      check("aujourdhui_ignores_type_fait_code", sql`${t["typeFait"]} ~ '${sql.raw(CODE)}'`),
      check("aujourdhui_ignores_reference_forme", sql`${t["reference"]} ~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$'`),
      check("aujourdhui_ignores_membre_borne", sql`${nonVide(t["membre"])} AND ${borne(t["membre"], 200)}`),
      index("aujourdhui_ignores_jour_idx").on(t["tenantId"] as never, t["jour"] as never),
    ],
  },
);
