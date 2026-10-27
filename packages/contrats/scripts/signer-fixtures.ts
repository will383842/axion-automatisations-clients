import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROUTES_C1, PREFIXE_C1, type RouteC1 } from "../src/c1/routes.ts";
import { ROUTE_C2 } from "../src/c2/enveloppe.ts";
import { Fait } from "../src/c2/faits.ts";
import { ROUTES_C4 } from "../src/c4/cellule.ts";
import { Configuration } from "../src/c4/configuration.ts";
import { EtatVoulu } from "../src/c4/etat-voulu.ts";
import { Paquet } from "../src/c4/evenements-executeur.ts";
import { INVARIANTS_C5, REGLES_C5, ROLES_ADMINISTRATION, TABLE_MIGRATIONS, VOCABULAIRE } from "../src/c5/invariants.ts";
import { CLE_OCTETS_MIN, CONSERVATION_JTI_SECONDES, DUREE_SECONDES, JETON_OCTETS_MAX, PREFIXE_KID, ROUTE_C6, VERSION_JETON } from "../src/c6/jeton.ts";
import { AVANCE_MAX_SECONDES } from "../src/c6/verifier.ts";
import { TVA_AUTOMATISATION_BPS } from "../src/commun/argent.ts";
import { LIMITES_DEBIT, RETRY_AFTER_MAX_SECONDES } from "../src/commun/debit.ts";
import { ErreurSchema, STATUT_PAR_CODE } from "../src/commun/erreurs.ts";
import { CURSEUR_INITIAL, PERIODE_MAX_MOIS, TERMES } from "../src/commun/identifiants.ts";
import { REGLES_FOND } from "../src/commun/regles-fond.ts";
import { ANTI_REJEU_SECONDES, CONSERVATION_IDEMPOTENCE_JOURS, EN_TETES, FENETRE_SECONDES, signer } from "../src/commun/signature.ts";
import { lireVersions } from "./versions.ts";

// Fixtures signées avec des clés de TEST (valeur en clair, jamais une vraie clé), une clé par sens, et JSON Schema 2020-12.
// Les règles que JSON Schema ne sait pas dire sont nommées par `x-axion-regles` (src/commun/regles-fond.ts).
export const CLES_TEST = {
  c1: { cle: "cle-test-c1-console-a", secret: "TEST-NE-PAS-UTILISER-cle-c1-console-a" },
  c2: { cle: "cle-test-c2-hub-a", secret: "TEST-NE-PAS-UTILISER-cle-c2-hub-a" },
} as const;
const HORODATAGE = "1792800000";
const RACINE = fileURLToPath(new URL("../", import.meta.url));
const SIRENS = (JSON.parse(readFileSync(`${RACINE}fixtures/c3/siren-generes.json`, "utf8")) as { sirens: string[] }).sirens;
const SIREN = SIRENS[0] as string;

const json = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-2020-12", unrepresentable: "any" });

export function schemasJson() {
  const v = lireVersions(RACINE);
  const routes = Object.fromEntries(
    Object.entries(ROUTES_C1).map(([nom, r]: [string, RouteC1]) => [
      nom,
      {
        methode: r.methode,
        chemin: r.chemin,
        limite: r.limite,
        antiDoublon: r.antiDoublon,
        ...(r.requete ? { requete: json(r.requete) } : {}),
        reponses: Object.fromEntries(Object.entries(r.reponses).map(([statut, s]) => [statut, json(s)])),
      },
    ]),
  );
  return {
    c1: { version: v.c1, routes },
    c2: { version: v.c2, route: ROUTE_C2, fait: json(Fait) },
    c4: { version: v.c4, routes: ROUTES_C4, configuration: json(Configuration), etatVoulu: json(EtatVoulu), paquet: json(Paquet) },
  };
}

// Constantes partagées : elles passent dans les fixtures pour que leur empreinte change avec elles.
export function constantes() {
  const v = lireVersions(RACINE);
  return {
    commun: {
      version: v.commun,
      chaineSignee: "v1\\n<horodatage>\\n<MÉTHODE>\\n<chemin + requête>\\n<sha256 hex du corps brut>",
      enTetes: EN_TETES,
      fenetreSecondes: FENETRE_SECONDES,
      antiRejeuSecondes: ANTI_REJEU_SECONDES,
      conservationIdempotenceJours: CONSERVATION_IDEMPOTENCE_JOURS,
      codesErreur: STATUT_PAR_CODE,
      erreur: json(ErreurSchema),
      limitesDebit: LIMITES_DEBIT,
      retryAfterMaxSecondes: RETRY_AFTER_MAX_SECONDES,
      tvaAutomatisationBps: TVA_AUTOMATISATION_BPS,
      periodeMaxMois: PERIODE_MAX_MOIS,
      termes: TERMES,
      curseurInitial: CURSEUR_INITIAL,
      reglesFond: Object.keys(REGLES_FOND),
    },
    c5: { version: v.c5, invariants: INVARIANTS_C5, regles: REGLES_C5, vocabulaire: VOCABULAIRE, tableMigrations: TABLE_MIGRATIONS, rolesAdministration: ROLES_ADMINISTRATION.source },
    c6: {
      version: v.c6,
      route: ROUTE_C6,
      dureeSecondes: DUREE_SECONDES,
      versionJeton: VERSION_JETON,
      cleOctetsMin: CLE_OCTETS_MIN,
      prefixeKid: PREFIXE_KID,
      jetonOctetsMax: JETON_OCTETS_MAX,
      avanceMaxSecondes: AVANCE_MAX_SECONDES,
      conservationJtiSecondes: CONSERVATION_JTI_SECONDES,
    },
  };
}

function cas(sens: keyof typeof CLES_TEST, nom: string, valide: boolean, methode: string, chemin: string, corps: unknown) {
  const { cle, secret } = CLES_TEST[sens];
  const brut = corps === undefined ? "" : JSON.stringify(corps);
  return { nom, valide, cle, secret, horodatage: HORODATAGE, methode, chemin, corps: brut, signature: signer(secret, HORODATAGE, methode, chemin, brut) };
}

const AXI = "AXI-CLI-000001";
const ligne = { libelle: "Ligne d'essai", quantite: 1, prixUnitaireHtCentimes: 12345, activite: "automatisation", tauxTvaBps: 2000 };
const plan = { axiCli: AXI, referenceContratConsole: "contrat-0001", montantHtCentimesParPeriode: 12345, periodeMois: 6, premiereEcheance: "2026-11-01", engagementMois: 12 };
const client = {
  consoleClientId: "console-cli-0001",
  siren: SIREN,
  raisonSociale: "Lemoine Rénovation",
  adresse: { ligne1: "1 rue d'essai", ligne2: "Bâtiment B", codePostal: "75001", ville: "Ville-Test", pays: "FR" },
  contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" },
};
const ponctuelle = {
  axiCli: AXI,
  codeAutomatisation: "tri-courriels",
  nature: "mise_en_place",
  debutPeriode: "2026-11-01",
  finPeriode: "2026-11-30",
  referenceBonDeCommande: "bdc-0001",
  lignes: [ligne],
  acompteBps: 3000,
};
const sans = (o: Record<string, unknown>, cle: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== cle));

const base = {
  event_id: "11111111-1111-4111-8111-111111111111",
  schema_version: 1,
  occurred_at: "2026-10-24T10:00:00Z",
  emitted_at: "2026-10-24T10:00:01Z",
  producer: "axion-ia-hub",
  subject_ref: { axiCli: AXI, consoleClientId: "console-cli-0001" },
  sequence: 1,
};
const devis = { numeroDevis: "AXI-DEV-000001", date: "2026-10-24" };
const fusion = { axiCliAbsorbe: "AXI-CLI-000002", axiCliGarde: AXI, annulableJusquau: "2026-10-31T10:00:00Z" };
const facture = {
  numeroFacture: "AXI-FACT-000001",
  idPlan: "plan-0001",
  referenceAbonnementConsole: "abonnement-0001",
  nature: "abonnement",
  debutPeriode: "2026-11-01",
  finPeriode: "2026-11-30",
  montantHtCentimes: 10000,
  montantTvaCentimes: 2000,
  montantTtcCentimes: 12000,
  dateEmission: "2026-10-24",
  dateEcheance: "2026-11-23",
  pdf: { url: "https://documents.exemple.fr/facture-0001.pdf", expireAt: "2026-10-25T10:00:00Z", sha256: "a".repeat(64) },
};
const ligneFacture = (ref: string, debut: string, fin: string, mois: number, montant: number) => ({
  referenceAbonnementConsole: ref, codeAutomatisation: "tri-courriels", libelle: "Automatisation d'essai", debutPeriode: debut, finPeriode: fin, periodeMois: mois, terme: "a_echoir", montantHtCentimes: montant, tauxTvaBps: 2000,
});
const factureGroupee = {
  ...sans(facture, "referenceAbonnementConsole"),
  numeroFacture: "AXI-FACT-000002",
  finPeriode: "2027-01-31",
  lignes: [ligneFacture("abonnement-0001", "2026-11-01", "2026-11-30", 1, 4000), ligneFacture("abonnement-0002", "2026-11-01", "2027-01-31", 3, 6000)],
};
const paiement = { numeroFacture: "AXI-FACT-000001", montantCentimes: 12000, dateReception: "2026-11-02", moyen: "virement" };
const fait = { ...base, event_type: "facture.emise", payload: facture };

type Reponse = { statut: number; nom: string; valide: boolean; corps: unknown };
type CasC1 = { methode: string; ok: [string, unknown]; invalides: [string, string, unknown][]; reponses: Reponse[] };
const r = (statut: number, nom: string, valide: boolean, corps: unknown): Reponse => ({ statut, nom, valide, corps });
const C1: Record<keyof typeof ROUTES_C1, CasC1> = {
  "clients-retrouver-ou-creer": {
    methode: "POST",
    ok: ["/clients/retrouver-ou-creer", client],
    invalides: [["pays hors France", "/clients/retrouver-ou-creer", { ...client, adresse: { ...client.adresse, pays: "BE" } }], ["SIREN qui échoue au contrôle de Luhn", "/clients/retrouver-ou-creer", { ...client, siren: "123456789" }]],
    reponses: [r(200, "créée", true, { resultat: "cree", axiCli: AXI }), r(200, "à trancher en 200", false, { resultat: "a_trancher", idDemande: "demande-0001" }), r(202, "à trancher", true, { resultat: "a_trancher", idDemande: "demande-0001" }), r(202, "retrouvée en 202", false, { resultat: "retrouve", axiCli: AXI })],
  },
  "clients-statut": {
    methode: "POST",
    ok: [`/clients/${AXI}/statut`, { statut: "client_actif", consoleClientId: "console-cli-0001" }],
    invalides: [["statut inconnu", `/clients/${AXI}/statut`, { statut: "dormant", consoleClientId: "console-cli-0001" }]],
    reponses: [r(200, "statut", true, { axiCli: AXI, statut: "client_actif" }), r(200, "statut du CRM", false, { axiCli: AXI, statut: "dormant" })],
  },
  devis: {
    methode: "POST",
    ok: ["/devis", { axiCli: AXI, referencePropositionConsole: "prop-0001", lignes: [ligne] }],
    invalides: [["client absent", "/devis", { referencePropositionConsole: "prop-0001", lignes: [ligne] }], ["montant flottant", "/devis", { axiCli: AXI, referencePropositionConsole: "prop-0001", lignes: [{ ...ligne, prixUnitaireHtCentimes: 100.5 }] }]],
    reponses: [r(201, "numéro", true, { numeroDevis: "AXI-DEV-000001" }), r(201, "numéro vide", false, { numeroDevis: "" })],
  },
  "plans-recurrents": {
    methode: "POST",
    ok: ["/plans-recurrents", plan],
    invalides: [["client absent", "/plans-recurrents", sans(plan, "axiCli")], ["période de 3 mois", "/plans-recurrents", { ...plan, periodeMois: 3 }]],
    reponses: [r(201, "plan", true, { idPlan: "plan-0001" }), r(201, "plan absent", false, {})],
  },
  "plans-recurrents-clore": {
    methode: "POST",
    ok: ["/plans-recurrents/plan-0001/clore", { dateFin: "2027-01-31", motif: "fin_engagement" }],
    invalides: [["motif en texte libre", "/plans-recurrents/plan-0001/clore", { dateFin: "2027-01-31", motif: "fin d'engagement" }], ["date mal formée", "/plans-recurrents/plan-0001/clore", { dateFin: "31/01/2027", motif: "fin_engagement" }]],
    reponses: [r(200, "clos", true, { idPlan: "plan-0001", brouillonsNonEmis: ["brouillon-0001"] }), r(200, "brouillons absents", false, { idPlan: "plan-0001" })],
  },
  "factures-ponctuelles": {
    methode: "POST",
    ok: ["/factures-ponctuelles", ponctuelle],
    invalides: [
      ["nature d'abonnement", "/factures-ponctuelles", { ...ponctuelle, nature: "abonnement" }],
      ["sans client ni automatisation", "/factures-ponctuelles", sans(sans(ponctuelle, "axiCli"), "codeAutomatisation")],
      ["sans lignes", "/factures-ponctuelles", { ...ponctuelle, lignes: [] }],
      ["acompte au-delà de 100 %", "/factures-ponctuelles", { ...ponctuelle, acompteBps: 10001 }],
      ["période inversée", "/factures-ponctuelles", { ...ponctuelle, debutPeriode: "2026-12-01" }],
    ],
    reponses: [r(201, "brouillon", true, { idBrouillon: "brouillon-0001" }), r(201, "facture émise", false, { idBrouillon: "brouillon-0001", numeroFacture: "AXI-FACT-000001" })],
  },
  statuts: {
    methode: "GET",
    ok: [`/statuts?depuis=${CURSEUR_INITIAL}`, undefined],
    invalides: [["curseur absent", "/statuts", undefined], ["curseur vide", "/statuts?depuis=", undefined]],
    reponses: [
      r(200, "statuts", true, { elements: [{ type: "devis", reference: "AXI-DEV-000001", statut: "signe" }, { type: "facture", reference: "AXI-FACT-000001", statut: "payee" }], curseur: "c-0002" }),
      r(200, "statut en texte libre", false, { elements: [{ type: "devis", reference: "AXI-DEV-000001", statut: "Signé le 3" }], curseur: "c-0002" }),
    ],
  },
  "clients-apporteurs": {
    methode: "GET",
    ok: [`/clients/${AXI}/apporteurs`, undefined],
    invalides: [["identifiant de client vide", "/clients//apporteurs", undefined]],
    reponses: [r(200, "apporteurs", true, { apporteurs: [{ idApporteur: "apporteur-0001", nom: "Atelier Bertin" }] }), r(200, "nom vide", false, { apporteurs: [{ idApporteur: "apporteur-0001", nom: "" }] })],
  },
  faits: {
    methode: "GET",
    ok: [`/faits?apres=${CURSEUR_INITIAL}&limite=100`, undefined],
    invalides: [["curseur vide", "/faits?apres=", undefined], ["limite au-delà de 500", `/faits?apres=${CURSEUR_INITIAL}&limite=501`, undefined]],
    reponses: [r(200, "faits", true, { faits: [fait], suivant: "c-0042", complet: true }), r(200, "suite absente", false, { faits: [fait] })],
  },
};

const C2: Record<string, { ok: unknown[]; invalides: [string, unknown][] }> = {
  "devis.signe": { ok: [devis], invalides: [] },
  "devis.refuse": { ok: [devis], invalides: [] },
  "devis.expire": { ok: [devis], invalides: [] },
  "facture.emise": {
    ok: [facture, factureGroupee, { ...sans(facture, "idPlan"), numeroFacture: "AXI-FACT-000003", nature: "mise_en_place", idBrouillon: "brouillon-0001", referenceBonDeCommande: "bdc-0001" }],
    invalides: [
      ["abonnement sans debutPeriode", sans(facture, "debutPeriode")],
      ["HT plus TVA différent de TTC", { ...facture, montantTtcCentimes: 12001 }],
      ["période inversée", { ...facture, debutPeriode: "2026-12-01" }],
      ["champ inconnu", { ...facture, remarque: "texte" }],
    ],
  },
  "paiement.recu": { ok: [paiement], invalides: [["montant flottant", { ...paiement, montantCentimes: 100.5 }]] },
  "avoir.emis": { ok: [{ numeroAvoir: "AXI-AVOIR-000001", numeroFactureOrigine: "AXI-FACT-000001", montantHtCentimes: 100 }], invalides: [["montant négatif", { numeroAvoir: "AXI-AVOIR-000001", numeroFactureOrigine: "AXI-FACT-000001", montantHtCentimes: -100 }]] },
  "relance.proposee": { ok: [{ numeroFacture: "AXI-FACT-000001", niveau: 1, joursRetard: 7 }], invalides: [] },
  "fiche.fusionnee": { ok: [fusion], invalides: [] },
  "fiche.fusion_annulee": { ok: [fusion], invalides: [] },
  "audit.cloture": {
    ok: [
      {
        siren: SIREN,
        contact: { nom: "Camille Test", email: "contact@exemple.fr" },
        typeAudit: "diagnostic_distance",
        dateAudit: "2026-10-20",
        outils: ["tableur"],
        besoins: [{ description: "Saisie répétée", priorite: 2, minutesPerduesParSemaineEstimees: 90 }],
        lienCompteRendu: "https://documents.exemple.fr/compte-rendu-0001",
      },
    ],
    invalides: [],
  },
};
const audit = (C2["audit.cloture"] as { ok: Record<string, unknown>[] }).ok[0] as Record<string, unknown>;
(C2["audit.cloture"] as { invalides: [string, unknown][] }).invalides.push(["SIREN qui échoue au contrôle de Luhn", { ...audit, siren: "123456789" }]);

// C4 : la cellule qui signe ne lit et n'écrit que pour ses instances (src/c4/cellule.ts).
const debut = (instanceId: string) => ({ type: "debut", instanceId, executionId: "exec-0001", a: "2026-10-24T10:00:00Z" });
export const CELLULES = {
  instances: { "inst-0001": "auto-run-1", "inst-0002": "auto-run-1", "inst-0101": "auto-run-2" },
  paquets: [
    { nom: "instances de la cellule qui signe", valide: true, cle: "c4:auto-run-1:a", corps: { evenements: [debut("inst-0001"), debut("inst-0002")] } },
    { nom: "instance d'une autre cellule", valide: false, cle: "c4:auto-run-1:a", corps: { evenements: [debut("inst-0101")] } },
    { nom: "paquet mixte refusé en entier", valide: false, cle: "c4:auto-run-1:a", corps: { evenements: [debut("inst-0001"), debut("inst-0101")] } },
    { nom: "signal de vie au nom d'une autre cellule", valide: false, cle: "c4:auto-run-1:a", corps: { evenements: [{ type: "signal_de_vie", instanceId: "inst-0001", celluleId: "auto-run-2", a: "2026-10-24T10:00:30Z" }] } },
    { nom: "clé qui n'est pas une clé de cellule", valide: false, cle: "cle-test-c1-console-a", corps: { evenements: [debut("inst-0001")] } },
  ],
  lectures: [
    { nom: "configuration de sa propre instance", valide: true, cle: "c4:auto-run-2:b", instanceId: "inst-0101" },
    { nom: "configuration d'une instance d'une autre cellule", valide: false, cle: "c4:auto-run-2:b", instanceId: "inst-0001" },
  ],
};

export function ecrireFixtures(racine: string): void {
  const ecrire = (f: string, v: unknown) => {
    mkdirSync(`${racine}/fixtures/${f.split("/")[0]}`, { recursive: true });
    writeFileSync(`${racine}/fixtures/${f}`, `${JSON.stringify(v, null, 2)}\n`);
  };
  for (const [route, c] of Object.entries(C1)) {
    const P = (chemin: string) => `${PREFIXE_C1}${chemin}`;
    ecrire(`c1/${route}.json`, {
      route,
      cas: [cas("c1", "valide", true, c.methode, P(c.ok[0]), c.ok[1]), ...c.invalides.map(([nom, chemin, corps]) => cas("c1", nom, false, c.methode, P(chemin), corps))],
      reponses: c.reponses,
    });
  }
  for (const [type, { ok, invalides }] of Object.entries(C2)) {
    const f = (extra: object, p: unknown) => ({ ...base, event_type: type, ...extra, payload: p });
    const { methode, chemin } = ROUTE_C2;
    ecrire(`c2/${type}.json`, {
      type,
      cas: [
        ...ok.map((p, i) => cas("c2", i === 0 ? "valide" : `valide ${i + 1}`, true, methode, chemin, f({}, p))),
        cas("c2", "event_id invalide", false, methode, chemin, f({ event_id: "pas-un-uuid" }, ok[0])),
        ...invalides.map(([nom, p]) => cas("c2", nom, false, methode, chemin, f({}, p))),
      ],
    });
  }
  const s = schemasJson();
  ecrire("c1/json-schema.json", s.c1);
  ecrire("c2/json-schema.json", s.c2);
  ecrire("c4/json-schema.json", s.c4);
  ecrire("c4/cellules.json", CELLULES);
  const k = constantes();
  ecrire("commun/constantes.json", k.commun);
  ecrire("c5/invariants.json", k.c5);
  ecrire("c6/constantes.json", k.c6);
}

// Usage : node scripts/signer-fixtures.ts, puis ECRIRE_FIXTURES_C3=1 pnpm test -- c3, puis node scripts/empreinte.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) ecrireFixtures(RACINE);
