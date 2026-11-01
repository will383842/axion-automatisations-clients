import { sql } from "drizzle-orm";
import { check, customType, foreignKey, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// État technique de l'exécuteur (base moteur) : sous les invariants C5, sans aucune donnée métier (C-022).
// Chaque table : tenant_id en tête et NOT NULL, RLS forcée écrite dans la migration, index qui commence par tenant_id.
const octets = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const instant = (nom: string) => timestamp(nom, { withTimezone: true });

export const issueExecution = pgEnum("issue_execution", ["reussite", "erreur"]);
export const statutEtape = pgEnum("statut_etape", ["en_cours", "reussie", "en_erreur"]);
export const etatIntention = pgEnum("etat_intention", ["ecrite", "faite", "a_trancher"]);
export const garantieIntention = pgEnum("garantie_intention", ["idempotent_par_cle", "verifiable_apres_coup", "au_plus_une_fois"]);

// Partitionnée par jour sur `debut` (pg_partman, migration) : la clé primaire contient la colonne de partition, donc pas de UNIQUE (tenant_id, id).
// Étiquettes client (tenant_id) et automatisation : A-372.
export const executions = pgTable(
  "executions",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    instanceId: uuid("instance_id").notNull(),
    automatisation: text("automatisation").notNull(),
    debut: instant("debut").notNull().defaultNow(),
    fin: instant("fin"),
    issue: issueExecution("issue"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id, t.debut] }),
    index("executions_tenant_id_idx").on(t.tenantId),
    index("executions_tenant_id_instance_id_idx").on(t.tenantId, t.instanceId),
    check("executions_fin_complete", sql`(${t.fin} IS NULL) = (${t.issue} IS NULL) AND (${t.fin} IS NULL OR ${t.fin} >= ${t.debut})`),
    check("executions_automatisation_code", sql`${t.automatisation} ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'`),
  ],
);

// `sortie_chiffree` : octets seulement (iv | chiffré | étiquette), jamais de texte. La clé de données chiffrée par la clé du client et sa version restent à côté.
export const journalEtape = pgTable(
  "journal_etape",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    executionId: uuid("execution_id").notNull(),
    debutExecution: instant("debut_execution").notNull(),
    etape: text("etape").notNull(),
    cle: text("cle").notNull(),
    statut: statutEtape("statut").notNull().default("en_cours"),
    sortieChiffree: octets("sortie_chiffree"),
    sortieCle: text("sortie_cle"),
    sortieVersion: integer("sortie_version"),
    creeLe: instant("cree_le").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique("journal_etape_tenant_id_execution_id_etape_cle_unique").on(t.tenantId, t.executionId, t.etape, t.cle),
    index("journal_etape_tenant_id_idx").on(t.tenantId),
    foreignKey({ name: "journal_etape_execution_fk", columns: [t.tenantId, t.executionId, t.debutExecution], foreignColumns: [executions.tenantId, executions.id, executions.debut] }),
    check("journal_etape_code", sql`${t.etape} ~ '^[a-z0-9][a-z0-9_.-]{0,63}$' AND ${t.cle} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
    check("journal_etape_sortie_complete", sql`(${t.sortieChiffree} IS NULL) = (${t.sortieCle} IS NULL) AND (${t.sortieChiffree} IS NULL) = (${t.sortieVersion} IS NULL)`),
  ],
);

// La clé d'intention est l'anti-doublon de dernier recours : unique PAR client (jamais seule : oracle d'existence entre clients, ADR 0040).
export const intentions = pgTable(
  "intentions",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    executionId: uuid("execution_id").notNull(),
    debutExecution: instant("debut_execution").notNull(),
    cleIntention: text("cle_intention").notNull(),
    garantie: garantieIntention("garantie").notNull(),
    etat: etatIntention("etat").notNull().default("ecrite"),
    creeLe: instant("cree_le").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique("intentions_tenant_id_cle_intention_unique").on(t.tenantId, t.cleIntention),
    index("intentions_tenant_id_idx").on(t.tenantId),
    foreignKey({ name: "intentions_execution_fk", columns: [t.tenantId, t.executionId, t.debutExecution], foreignColumns: [executions.tenantId, executions.id, executions.debut] }),
    check("intentions_cle_forme", sql`${t.cleIntention} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  ],
);

// Valeur opaque : le noyau la lit et l'écrit sans l'interpréter ; bornée en taille, aucun contenu de personne.
export const curseurs = pgTable(
  "curseurs",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    instanceId: uuid("instance_id").notNull(),
    declencheur: text("declencheur").notNull(),
    valeur: text("valeur").notNull(),
    changeLe: instant("change_le").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique("curseurs_tenant_id_instance_id_declencheur_unique").on(t.tenantId, t.instanceId, t.declencheur),
    index("curseurs_tenant_id_idx").on(t.tenantId),
    check("curseurs_forme", sql`${t.declencheur} ~ '^[a-z0-9][a-z0-9_.-]{0,63}$' AND length(${t.valeur}) <= 512`),
  ],
);
