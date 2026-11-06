import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, integer, pgEnum, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tableClient, tableCommune } from "./aides.ts";
import { automatisations, familleConnecteur } from "./catalogue.ts";
import { organisations } from "./clients.ts";

// Suivi du client (C5, lot 2, ADR 0055) : notes de l'équipe, demandes (métadonnées), cellules, thème, outils, audits, besoins, propositions, registre des traitements.
// Minimisation (C-034) : la console ne garde que des métadonnées ; le texte d'une demande vit dans la base du client, ici seulement une référence.
// Le Hub fait foi (ADR 0053) : aucun prix, aucun montant dans ces tables. Vocabulaires provisoires : additifs, jamais renommés.
export const typeNote = pgEnum("type_note", ["appel", "demande", "incident"]);
export const canalDemande = pgEnum("canal_demande", ["courriel", "telephone", "portail", "rendez_vous", "autre"]);
export const niveauPriorite = pgEnum("niveau_priorite", ["basse", "normale", "haute", "urgente"]);
export const statutDemande = pgEnum("statut_demande", ["nouvelle", "en_cours", "en_attente", "resolue", "close"]);
export const modeCellule = pgEnum("mode_cellule", ["mutualise", "dedie"]);
export const etatCellule = pgEnum("etat_cellule", ["active", "saturee", "hors_ligne", "maintenance"]);
export const tonTheme = pgEnum("ton_theme", ["formel", "chaleureux", "neutre"]);
export const typeAudit = pgEnum("type_audit", ["decouverte", "approfondi", "suivi"]);
export const statutProposition = pgEnum("statut_proposition", ["brouillon", "envoyee", "acceptee", "refusee", "expiree"]);
export const baseLegale = pgEnum("base_legale", ["contrat", "obligation_legale", "interet_legitime", "consentement"]);

const CODE = "^[a-z][a-z0-9_.-]{0,63}$";
const JETON = "^[a-z][a-zA-Z0-9.]{0,63}$"; // chemin d'un jeton de design (packages/design) : jamais une couleur écrite en dur
const REF_OBJET = "^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$";
const REF_HUB = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";
const MAX_MINUTES = 1_000_000;
const nonVide = (c: unknown) => sql`length(btrim(${c})) > 0`;
const borne = (c: unknown, max: number) => sql`char_length(${c}) <= ${sql.raw(String(max))}`;
const plage = (c: unknown, min: number, max: number) => sql`${c} BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))}`;
const organisationFk = (nom: string) => (t: Record<string, unknown>) =>
  foreignKey({ name: `${nom}_organisation_fk`, columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] });

// Note de suivi (A-132) : texte de l'ÉQUIPE, court et borné, jamais un contenu de travail du client. Ajout seul pour l'application (aucune modification, aucun DELETE) ;
// l'auteur est l'appelant. Pas de copie au journal (audit: false) : le texte peut citer des personnes (ADR 0044). La fin de conservation se calcule en T2-11.
export const notes = tableClient(
  "notes",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    auteur: text("auteur").notNull(),
    texte: text("texte").notNull(),
    type: typeNote("type").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    audit: false,
    contraintes: (t) => [
      organisationFk("notes")(t),
      check("notes_auteur_non_vide", sql`${nonVide(t["auteur"])} AND ${borne(t["auteur"], 200)}`),
      check("notes_texte_non_vide", nonVide(t["texte"])),
      check("notes_texte_longueur", sql`char_length(${t["texte"]}) BETWEEN 1 AND 1000`),
    ],
  },
);

// Demande (A-136) : métadonnées seulement. `reference_texte` est un pointeur « demande:<uuid> » vers la base du client ; AUCUNE colonne de texte libre (C-034).
export const demandes = tableClient(
  "demandes",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    automatisationId: uuid("automatisation_id").references(() => automatisations.id, { onDelete: "restrict" }),
    canal: canalDemande("canal").notNull(),
    categorie: text("categorie").notNull(),
    priorite: niveauPriorite("priorite").notNull().default("normale"),
    statut: statutDemande("statut").notNull().default("nouvelle"),
    responsable: text("responsable"),
    referenceTexte: text("reference_texte").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("demandes")(t),
      unique("demandes_tenant_id_reference_texte_unique").on(t["tenantId"] as never, t["referenceTexte"] as never),
      check("demandes_reference_texte_format", sql`${t["referenceTexte"]} ~ '^demande:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`),
      check("demandes_reference_texte_longueur", borne(t["referenceTexte"], 64)),
      check("demandes_categorie_code", sql`${t["categorie"]} ~ '${sql.raw(CODE)}'`),
      check("demandes_responsable_borne", sql`${t["responsable"]} IS NULL OR (${nonVide(t["responsable"])} AND ${borne(t["responsable"], 200)})`),
    ],
  },
);

// Cellule (A-134, partiel : une seule cellule en V1, rien ne l'impose) : table COMMUNE, sans tenant_id, écrite par l'équipe seule. L'adresse interne n'est lisible
// que par l'équipe (aucun droit pour console_app). Les fixtures de test utilisent des noms en « .test ».
export const cellules = tableCommune(
  "cellules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    adresseInterne: text("adresse_interne").notNull(),
    mode: modeCellule("mode").notNull(),
    capacite: integer("capacite").notNull(),
    nombreInstances: integer("nombre_instances").notNull().default(0),
    versionImage: text("version_image").notNull(),
    dernierSignalLe: timestamp("dernier_signal_le", { withTimezone: true }),
    etat: etatCellule("etat").notNull().default("hors_ligne"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("cellules_code_unique").on(t["code"] as never),
    check("cellules_code_format", sql`${t["code"]} ~ '^[a-z][a-z0-9_-]{0,62}$'`),
    // T2-52 : forme C4 du code (pas de _), en plus de la contrainte ci-dessus qui reste en place.
    check("cellules_code_forme_c4", sql`${t["code"]} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t["code"]}) <= 64`),
    check("cellules_adresse_format", sql`${t["adresseInterne"]} ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'`),
    check("cellules_capacite_bornee", plage(t["capacite"], 1, 100000)),
    check("cellules_instances_bornees", plage(t["nombreInstances"], 0, 100000)),
    check("cellules_version_image_format", sql`${t["versionImage"]} ~ '^[a-z0-9][a-z0-9._+-]{0,63}$'`),
  ],
);

// Thème du client (A-138, partiel : le rendu vient aux lots 3 et 6) : des JETONS de design (noms), jamais une couleur écrite en dur. Un seul thème actif par client ;
// sans ligne active, le thème AXION s'applique (THEME_AXION, themeEffectif).
export const themesClient = tableClient(
  "themes_client",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    logoRef: text("logo_ref"),
    // Valeurs : chemins de jetons de packages/design (« couleur.action »), jamais une couleur écrite en dur (le nom « jeton » est réservé par la garde des colonnes).
    couleurPrincipale: text("couleur_principale").notNull().default("couleur.action"),
    couleurAccent: text("couleur_accent").notNull().default("couleur.teinte.vert.liseret"),
    police: text("police").notNull().default("police.titre"),
    ton: tonTheme("ton").notNull().default("neutre"),
    signature: text("signature"),
    mentionsLegales: text("mentions_legales"),
    actif: boolean("actif").notNull().default(false),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("themes_client")(t),
      uniqueIndex("themes_client_un_actif").on(t["tenantId"] as never).where(sql`${t["actif"]}`),
      check("themes_client_logo_ref_format", sql`${t["logoRef"]} IS NULL OR (${t["logoRef"]} ~ '${sql.raw(REF_OBJET)}' AND ${t["logoRef"]} !~ '\\.\\.')`),
      check("themes_client_couleur_principale_jeton", sql`${t["couleurPrincipale"]} ~ '${sql.raw(JETON)}'`),
      check("themes_client_couleur_accent_jeton", sql`${t["couleurAccent"]} ~ '${sql.raw(JETON)}'`),
      check("themes_client_police_jeton", sql`${t["police"]} ~ '${sql.raw(JETON)}'`),
      check("themes_client_signature_borne", sql`${t["signature"]} IS NULL OR char_length(${t["signature"]}) <= 500`),
      check("themes_client_mentions_bornees", sql`${t["mentionsLegales"]} IS NULL OR char_length(${t["mentionsLegales"]}) <= 2000`),
    ],
  },
);

// Thème AXION IA par défaut : jetons de packages/design, jamais de couleur écrite ici.
export const THEME_AXION = Object.freeze({
  couleurPrincipale: "couleur.action",
  couleurAccent: "couleur.teinte.vert.liseret",
  police: "police.titre",
  ton: "neutre",
  logoRef: null,
  signature: null,
  mentionsLegales: null,
});
// Le thème d'un client : sa ligne active, sinon le thème AXION (A-138).
export function themeEffectif<T extends { actif: boolean }>(lignes: readonly T[]): T | typeof THEME_AXION {
  return lignes.find((l) => l.actif) ?? THEME_AXION;
}

// Outil du client (A-140) : famille (celles des connecteurs du catalogue), nom de l'outil, connecteur disponible ou non.
export const outilsClient = tableClient(
  "outils_client",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    famille: familleConnecteur("famille").notNull(),
    outil: text("outil").notNull(),
    connecteurDisponible: boolean("connecteur_disponible").notNull().default(false),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("outils_client")(t),
      unique("outils_client_tenant_id_organisation_id_outil_unique").on(t["tenantId"] as never, t["organisationId"] as never, t["outil"] as never),
      check("outils_client_outil_code", sql`${t["outil"]} ~ '${sql.raw(CODE)}'`),
    ],
  },
);

// Audit du client (A-151, partiel : la réception automatique est en V2) : type, date, identifiant sur axion-ia.com ; le compte rendu est une RÉFÉRENCE d'objet, jamais un texte.
export const audits = tableClient(
  "audits_client",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    type: typeAudit("type").notNull(),
    dateAudit: date("date_audit").notNull(),
    identifiantHub: text("identifiant_hub").notNull(),
    compteRenduRef: text("compte_rendu_ref"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("audits_client")(t),
      unique("audits_client_tenant_id_identifiant_hub_unique").on(t["tenantId"] as never, t["identifiantHub"] as never),
      check("audits_client_identifiant_hub_format", sql`${t["identifiantHub"]} ~ '${sql.raw(REF_HUB)}'`),
      check("audits_client_compte_rendu_ref_format", sql`${t["compteRenduRef"]} IS NULL OR (${t["compteRenduRef"]} ~ '${sql.raw(REF_OBJET)}' AND ${t["compteRenduRef"]} !~ '\\.\\.')`),
    ],
  },
);

// Besoin repéré par un audit (A-152) : catégorie (code), priorité, temps perdu estimé en minutes, automatisation rapprochée (facultative). Pas de description libre.
export const besoins = tableClient(
  "besoins",
  {
    id: uuid("id").notNull(),
    auditId: uuid("audit_id").notNull(),
    categorie: text("categorie").notNull(),
    priorite: niveauPriorite("priorite").notNull().default("normale"),
    minutesPerduesEstimees: integer("minutes_perdues_estimees").notNull(),
    automatisationId: uuid("automatisation_id").references(() => automatisations.id, { onDelete: "restrict" }),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "besoins_audit_fk", columns: [t["tenantId"] as never, t["auditId"] as never], foreignColumns: [audits.tenantId, audits.id] }),
      check("besoins_categorie_code", sql`${t["categorie"]} ~ '${sql.raw(CODE)}'`),
      check("besoins_minutes_bornees", plage(t["minutesPerduesEstimees"], 0, MAX_MINUTES)),
    ],
  },
);

// Proposition (A-153, partiel) : statut, identifiant sur axion-ia.com, nombre de paliers ; AUCUN prix (le Hub fait foi, ADR 0053). Reçue dans l'état où le Hub l'a émise.
export const propositions = tableClient(
  "propositions",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    auditId: uuid("audit_id"),
    statut: statutProposition("statut").notNull().default("brouillon"),
    identifiantHub: text("identifiant_hub").notNull(),
    nombrePaliers: integer("nombre_paliers").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("propositions")(t),
      foreignKey({ name: "propositions_audit_fk", columns: [t["tenantId"] as never, t["auditId"] as never], foreignColumns: [audits.tenantId, audits.id] }),
      unique("propositions_tenant_id_identifiant_hub_unique").on(t["tenantId"] as never, t["identifiantHub"] as never),
      check("propositions_identifiant_hub_format", sql`${t["identifiantHub"]} ~ '${sql.raw(REF_HUB)}'`),
      check("propositions_paliers_bornes", plage(t["nombrePaliers"], 1, 5)),
    ],
  },
);

// Automatisations d'une proposition, avec leur palier. Ajout seul.
export const propositionsAutomatisations = tableClient(
  "propositions_automatisations",
  {
    id: uuid("id").notNull(),
    propositionId: uuid("proposition_id").notNull(),
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
    palier: integer("palier").notNull(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "propositions_automatisations_proposition_fk", columns: [t["tenantId"] as never, t["propositionId"] as never], foreignColumns: [propositions.tenantId, propositions.id] }),
      unique("propositions_automatisations_unique").on(t["tenantId"] as never, t["propositionId"] as never, t["automatisationId"] as never),
      check("propositions_automatisations_palier_borne", plage(t["palier"], 1, 5)),
    ],
  },
);

// Registre des traitements (A-200, art. 30.2) : table COMMUNE, écrite et lue par l'équipe seule. Textes bornés : le registre décrit, il ne contient aucune donnée de client.
export const registreTraitements = tableCommune(
  "registre_traitements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    finalite: text("finalite").notNull(),
    baseLegale: baseLegale("base_legale").notNull(),
    categoriesDonnees: text("categories_donnees").notNull(),
    destinataires: text("destinataires").notNull(),
    dureeConservation: text("duree_conservation").notNull(),
    mesuresSecurite: text("mesures_securite").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("registre_traitements_code_unique").on(t["code"] as never),
    check("registre_traitements_code_format", sql`${t["code"]} ~ '${sql.raw(CODE)}'`),
    ...(["finalite", "categoriesDonnees", "destinataires", "dureeConservation", "mesuresSecurite"] as const).map((c) =>
      check(`registre_traitements_${c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}_borne`, sql`char_length(${t[c]}) BETWEEN 1 AND 1000`),
    ),
  ],
);
