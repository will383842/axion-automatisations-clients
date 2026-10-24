import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROUTES_C1, PREFIXE_C1, type RouteC1 } from "../src/c1/routes.ts";
import { Fait } from "../src/c2/faits.ts";
import { signer } from "../src/commun/signature.ts";

// Fixtures signées avec la clé de TEST (valeur en clair, jamais une vraie clé) et JSON Schema 2020-12.
const CLE = "cle-test-c1-console-a";
const SECRET = "TEST-NE-PAS-UTILISER-cle-c1-console-a";
const HORODATAGE = "1792800000";

const json = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-2020-12", unrepresentable: "any" });

export function schemasJson() {
  const routes = Object.fromEntries(
    Object.entries(ROUTES_C1).map(([nom, r]: [string, RouteC1]) => [
      nom,
      {
        methode: r.methode,
        chemin: r.chemin,
        ...(r.requete ? { requete: json(r.requete) } : {}),
        reponses: Object.fromEntries(Object.entries(r.reponses).map(([statut, s]) => [statut, json(s)])),
      },
    ]),
  );
  return { c1: { version: "0.1.0", routes }, c2: { version: "0.1.0", fait: json(Fait) } };
}

function cas(nom: string, valide: boolean, methode: string, chemin: string, corps: unknown) {
  const brut = corps === undefined ? "" : JSON.stringify(corps);
  return { nom, valide, cle: CLE, secret: SECRET, horodatage: HORODATAGE, methode, chemin, corps: brut, signature: signer(SECRET, HORODATAGE, methode, chemin, brut) };
}

const ligne = { libelle: "Ligne d'essai", quantite: 1, prixUnitaireHtCentimes: 12345, activite: "automatisation", tauxTvaBps: 2000 };
const plan = { referenceContratConsole: "contrat-0001", montantHtCentimesParPeriode: 12345, periodeMois: 6, premiereEcheance: "2026-11-01", engagementMois: 12 };
const client = {
  consoleClientId: "console-cli-0001",
  siren: "123456789",
  raisonSociale: "Lemoine Rénovation",
  adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" },
  contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" },
};
const P = (c: string) => `${PREFIXE_C1}${c}`;
const AXI = "/clients/AXI-CLI-000001";

// [route, méthode, chemin valide, corps valide, nom de l'invalide, chemin invalide, corps invalide]
const C1: [string, string, string, unknown, string, string, unknown][] = [
  ["clients-retrouver-ou-creer", "POST", "/clients/retrouver-ou-creer", client, "pays hors France", "/clients/retrouver-ou-creer", { ...client, adresse: { ...client.adresse, pays: "BE" } }],
  ["clients-statut", "POST", `${AXI}/statut`, { statut: "client_actif", consoleClientId: "console-cli-0001" }, "statut inconnu", `${AXI}/statut`, { statut: "dormant", consoleClientId: "console-cli-0001" }],
  ["devis", "POST", "/devis", { referencePropositionConsole: "prop-0001", lignes: [ligne] }, "montant flottant", "/devis", { referencePropositionConsole: "prop-0001", lignes: [{ ...ligne, prixUnitaireHtCentimes: 100.5 }] }],
  ["plans-recurrents", "POST", "/plans-recurrents", plan, "période de 3 mois", "/plans-recurrents", { ...plan, periodeMois: 3 }],
  ["plans-recurrents-clore", "POST", "/plans-recurrents/plan-0001/clore", { dateFin: "2027-01-31", motif: "fin d'engagement" }, "date mal formée", "/plans-recurrents/plan-0001/clore", { dateFin: "31/01/2027", motif: "fin d'engagement" }],
  ["factures-ponctuelles", "POST", "/factures-ponctuelles", { nature: "mise_en_place", debutPeriode: "2026-11-01", finPeriode: "2026-11-30", referenceBonDeCommande: "bdc-0001" }, "nature d'abonnement", "/factures-ponctuelles", { nature: "abonnement", debutPeriode: "2026-11-01", finPeriode: "2026-11-30", referenceBonDeCommande: "bdc-0001" }],
  ["statuts", "GET", "/statuts?depuis=0", undefined, "curseur absent", "/statuts", undefined],
  ["clients-apporteurs", "GET", `${AXI}/apporteurs`, undefined, "identifiant de client vide", "/clients//apporteurs", undefined],
  ["faits", "GET", "/faits?apres=42", undefined, "séquence non numérique", "/faits?apres=abc", undefined],
];

const base = {
  event_id: "11111111-1111-4111-8111-111111111111",
  schema_version: 1,
  occurred_at: "2026-10-24T10:00:00Z",
  emitted_at: "2026-10-24T10:00:01Z",
  producer: "axion-ia-hub",
  subject_ref: { axiCli: "AXI-CLI-000001", consoleClientId: "console-cli-0001" },
  sequence: 1,
};
const devis = { numeroDevis: "AXI-DEV-000001", date: "2026-10-24" };
const fusion = { axiCliAbsorbe: "AXI-CLI-000002", axiCliGarde: "AXI-CLI-000001", annulableJusquau: "2026-10-31T10:00:00Z" };
const facture = {
  numeroFacture: "AXI-FACT-000001",
  idPlan: "plan-0001",
  nature: "abonnement",
  debutPeriode: "2026-11-01",
  finPeriode: "2026-11-30",
  montantHtCentimes: 100,
  montantTvaCentimes: 20,
  montantTtcCentimes: 120,
  dateEmission: "2026-10-24",
  dateEcheance: "2026-11-23",
  pdf: { url: "https://documents.exemple.fr/facture-0001.pdf", expireAt: "2026-10-25T10:00:00Z", sha256: "a".repeat(64) },
};
const factureSansDebut: Record<string, unknown> = { ...facture };
delete factureSansDebut.debutPeriode;
const paiement = { numeroFacture: "AXI-FACT-000001", montantCentimes: 120, dateReception: "2026-11-02", moyen: "virement" };

const C2: Record<string, unknown> = {
  "devis.signe": devis,
  "devis.refuse": devis,
  "devis.expire": devis,
  "facture.emise": facture,
  "paiement.recu": paiement,
  "avoir.emis": { numeroAvoir: "AXI-AVOIR-000001", numeroFactureOrigine: "AXI-FACT-000001", montantHtCentimes: 100 },
  "relance.proposee": { numeroFacture: "AXI-FACT-000001", niveau: 1, joursRetard: 7 },
  "fiche.fusionnee": fusion,
  "fiche.fusion_annulee": fusion,
  "audit.cloture": {
    siren: "123456789",
    contact: { nom: "Camille Test", email: "contact@exemple.fr" },
    typeAudit: "diagnostic_distance",
    dateAudit: "2026-10-20",
    outils: ["tableur"],
    besoins: [{ description: "Saisie répétée", priorite: 2, minutesPerduesParSemaineEstimees: 90 }],
    lienCompteRendu: "https://documents.exemple.fr/compte-rendu-0001",
  },
};

export function ecrireFixtures(racine: string): void {
  const ecrire = (f: string, v: unknown) => writeFileSync(`${racine}/fixtures/${f}`, `${JSON.stringify(v, null, 2)}\n`);
  for (const [route, methode, ok, corpsOk, nomKo, ko, corpsKo] of C1) {
    ecrire(`c1/${route}.json`, { route, cas: [cas("valide", true, methode, P(ok), corpsOk), cas(nomKo, false, methode, P(ko), corpsKo)] });
  }
  for (const [type, payload] of Object.entries(C2)) {
    const fait = (extra: object, p: unknown = payload) => ({ ...base, event_type: type, ...extra, payload: p });
    const chemin = "/api/hub/v1/faits";
    const invalides = [cas("event_id invalide", false, "POST", chemin, fait({ event_id: "pas-un-uuid" }))];
    if (type === "facture.emise") invalides.push(cas("abonnement sans debutPeriode", false, "POST", chemin, fait({}, factureSansDebut)));
    if (type === "paiement.recu") invalides.push(cas("montant flottant", false, "POST", chemin, fait({}, { ...paiement, montantCentimes: 100.5 })));
    ecrire(`c2/${type}.json`, { type, cas: [cas("valide", true, "POST", chemin, fait({})), ...invalides] });
  }
  const s = schemasJson();
  ecrire("c1/json-schema.json", s.c1);
  ecrire("c2/json-schema.json", s.c2);
}

// Usage : node scripts/signer-fixtures.ts puis node scripts/empreinte.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) ecrireFixtures(fileURLToPath(new URL("../", import.meta.url)));
