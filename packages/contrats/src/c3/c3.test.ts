import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { calculerEmpreintes } from "../../scripts/empreinte.ts";
import { signer, verifier } from "../commun/signature.ts";
import { EvenementCrm, TYPES_CRM_VERS_CONSOLE, empreinteEmail, identifiantEvenementC3 } from "./evenements-crm-vers-console.ts";
import { EvenementConsole, TYPES_V1, TYPES_V2, statutCrmDepuisHub, statutHubDepuisCrm } from "./evenements-console-vers-crm.ts";
import { CHEMIN_LECTURE, LectureReponse, LectureRequete } from "./lecture-entreprise.ts";

const racine = new URL("../../", import.meta.url);
const lire = (p: string) => readFileSync(new URL(p, racine), "utf8");
const SIRENS = (JSON.parse(lire("fixtures/c3/siren-generes.json")) as { sirens: string[] }).sirens;
const [SIREN, SIREN_ABSORBE] = SIRENS as [string, string];

const base = {
  event_id: "11111111-1111-4111-8111-111111111111",
  schema_version: 1,
  occurred_at: "2026-10-24T10:00:00Z",
  emitted_at: "2026-10-24T10:00:01Z",
  sequence: 1,
};
const adresse = { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" };
const deCrm = (event_type: string, payload: unknown, extra: object = {}) => ({
  ...base, producer: "axion-crm", subject_ref: { crmCompanyId: "crm-0001" }, event_type, payload, ...extra,
});
const deConsole = (event_type: string, payload: unknown, extra: object = {}) => ({
  ...base, producer: "axion-console", subject_ref: { consoleClientId: "console-cli-0001" }, event_type, payload, ...extra,
});
const personne = { personKey: "personne-0001", emailEmpreinte: empreinteEmail("Contact@exemple.fr") };

describe("contrat C3 : CRM vers console", () => {
  it("[LOT0-c3] les 6 types CRM vers console sont déclarés", () => {
    expect([...TYPES_CRM_VERS_CONSOLE].sort()).toEqual(
      ["apporteur.rattache", "consentement.retire", "effacement.demande", "entreprise.devenue_cliente", "entreprise.mise_a_jour", "fiche.fusionnee"],
    );
  });
  it("[LOT0-c3] consentement.retire avec un champ email en clair est refusé", () => {
    expect(EvenementCrm.safeParse(deCrm("consentement.retire", personne)).success).toBe(true);
    expect(EvenementCrm.safeParse(deCrm("consentement.retire", { ...personne, email: "contact@exemple.fr" })).success).toBe(false);
    expect(EvenementCrm.safeParse(deCrm("effacement.demande", { ...personne, email: "contact@exemple.fr" })).success).toBe(false);
  });
  it("[LOT0-c3] l'empreinte de l'e-mail est un SHA-256 hexadécimal de l'e-mail en minuscules sans espaces", () => {
    const attendu = createHash("sha256").update("contact@exemple.fr").digest("hex");
    expect(empreinteEmail("  Contact@Exemple.FR ")).toBe(attendu);
    expect(EvenementCrm.safeParse(deCrm("effacement.demande", { ...personne, emailEmpreinte: "contact@exemple.fr" })).success).toBe(false);
  });
  it("[LOT0-c3] la même entreprise devenue cliente deux fois donne le même event_id", () => {
    const a = identifiantEvenementC3("entreprise.devenue_cliente", "crm-0001");
    expect(identifiantEvenementC3("entreprise.devenue_cliente", "crm-0001")).toBe(a);
    expect(identifiantEvenementC3("entreprise.devenue_cliente", "crm-0002")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("[LOT0-c3] un SIREN de 8 chiffres ou qui échoue au contrôle de Luhn est refusé, un SIREN généré est accepté", () => {
    const devenue = (siren: string) =>
      deCrm("entreprise.devenue_cliente", {
        crmCompanyId: "crm-0001", siren, raisonSociale: "Lemoine Rénovation", adresse, contacts: [{ nom: "Camille Test", email: "contact@exemple.fr" }],
      });
    expect(EvenementCrm.safeParse(devenue(SIREN)).success).toBe(true);
    expect(EvenementCrm.safeParse(devenue(SIREN.slice(0, 8))).success).toBe(false);
    expect(EvenementCrm.safeParse(devenue("123456789")).success).toBe(false);
  });
  it("[LOT0-c3] le producteur doit être axion-crm", () => {
    expect(EvenementCrm.safeParse(deCrm("fiche.fusionnee", { crmCompanyIdAbsorbee: "crm-0002", crmCompanyIdGardee: "crm-0001" })).success).toBe(true);
    expect(EvenementCrm.safeParse(deCrm("fiche.fusionnee", { crmCompanyIdAbsorbee: "crm-0002", crmCompanyIdGardee: "crm-0001" }, { producer: "axion-ia-hub" })).success).toBe(false);
  });
});

describe("contrat C3 : console vers CRM", () => {
  it("[LOT0-c3] les 7 types V1 sont déclarés, les 2 types V2 sont marqués V2", () => {
    expect([...TYPES_V1].sort()).toEqual(["automatisation.activee", "client.cree", "client.statut", "contrat.resilie", "impaye.signale", "plan.resume", "renouvellement.proche"]);
    expect([...TYPES_V2].sort()).toEqual(["maintenance.fin_incluse", "risque_depart"]);
  });
  it("[LOT0-c3] un événement V2 est refusé en V1", () => {
    for (const t of TYPES_V2) expect(EvenementConsole.safeParse(deConsole(t, { consoleClientId: "console-cli-0001" })).success).toBe(false);
  });
  it("[LOT0-c3] plan.resume ne porte aucun montant", () => {
    const resume = { consoleClientId: "console-cli-0001", codesAutomatisation: ["tri-courriels"], palier: "palier-1", periodeMois: 6, prochaineEcheance: "2027-04-01" };
    expect(EvenementConsole.safeParse(deConsole("plan.resume", resume)).success).toBe(true);
    expect(EvenementConsole.safeParse(deConsole("plan.resume", { ...resume, montantHtCentimes: 1000 })).success).toBe(false);
  });
  it("[LOT0-c3] client.statut accepte client, dormant, perdu et rien d'autre", () => {
    for (const statut of ["client", "dormant", "perdu"]) expect(EvenementConsole.safeParse(deConsole("client.statut", { consoleClientId: "console-cli-0001", statut })).success).toBe(true);
    expect(EvenementConsole.safeParse(deConsole("client.statut", { consoleClientId: "console-cli-0001", statut: "prospect" })).success).toBe(false);
  });
  it("[LOT0-c3] table de correspondance des statuts Hub et CRM", () => {
    expect(statutCrmDepuisHub("prospect")).toBeNull();
    expect(statutCrmDepuisHub("client_actif")).toBe("client");
    expect(statutCrmDepuisHub("ancien_client")).toBe("perdu");
    expect(statutHubDepuisCrm("client")).toBe("client_actif");
    expect(statutHubDepuisCrm("dormant")).toBe("client_actif");
    expect(statutHubDepuisCrm("perdu")).toBe("ancien_client");
  });
});

describe("contrat C3 : lecture par SIREN", () => {
  it("[LOT0-c3] le chemin de lecture est celui de l'annexe", () => {
    expect(CHEMIN_LECTURE).toBe("/api/console/v1/entreprises");
  });
  it("[LOT0-c3] lecture avec siren ET siret refusée, comme sans aucun des deux", () => {
    expect(LectureRequete.safeParse({ siren: SIREN }).success).toBe(true);
    expect(LectureRequete.safeParse({ siret: `${SIREN}00011` }).success).toBe(true);
    expect(LectureRequete.safeParse({ siren: SIREN, siret: `${SIREN}00011` }).success).toBe(false);
    expect(LectureRequete.safeParse({}).success).toBe(false);
    expect(LectureRequete.safeParse({ siren: SIREN.slice(0, 8) }).success).toBe(false);
  });
  it("[C-550] une réponse « absorbeePar » est valide et distincte d'une fiche active", () => {
    const active = { crmCompanyId: "crm-0001", raisonSociale: "Lemoine Rénovation", adresse, siretEtablissement: `${SIREN}00011` };
    const absorbee = { ...active, crmCompanyId: "crm-0002", absorbeePar: "crm-0001" };
    const a = LectureReponse.safeParse(active);
    const b = LectureReponse.safeParse(absorbee);
    expect(a.success && b.success).toBe(true);
    expect(a.success && "absorbeePar" in a.data).toBe(false);
    expect(b.success && b.data.absorbeePar).toBe("crm-0001");
    expect(LectureReponse.safeParse({ ...active, absorbeePar: "" }).success).toBe(false);
  });
  it("[LOT0-c3] les champs foreign_id et external_ref du CRM ne sont jamais acceptés", () => {
    const active = { crmCompanyId: "crm-0001", raisonSociale: "Lemoine Rénovation", adresse, siretEtablissement: `${SIREN}00011` };
    expect(LectureReponse.safeParse({ ...active, foreign_id: "x" }).success).toBe(false);
    expect(LectureReponse.safeParse({ ...active, external_ref: "x" }).success).toBe(false);
  });
});

// Fixtures : construites ici, comparées au disque ; ECRIRE_FIXTURES_C3=1 les réécrit (puis relancer node scripts/empreinte.ts).
const HORODATAGE = "1792800000";
const SENS = {
  crm: { cle: "cle-test-c3-crm-a", secret: "TEST-NE-PAS-UTILISER-cle-c3-crm-a", chemin: "/api/crm/v1/evenements" },
  console: { cle: "cle-test-c3-console-a", secret: "TEST-NE-PAS-UTILISER-cle-c3-console-a", chemin: "/api/console/v1/evenements" },
} as const;
const cas = (sens: keyof typeof SENS, nom: string, valide: boolean, methode: string, chemin: string, corps?: unknown) => {
  const brut = corps === undefined ? "" : JSON.stringify(corps);
  const { cle, secret } = SENS[sens];
  return { nom, valide, cle, secret, horodatage: HORODATAGE, methode, chemin, corps: brut, signature: signer(secret, HORODATAGE, methode, chemin, brut) };
};
const devenue = {
  crmCompanyId: "crm-0001", siren: SIREN, siret: `${SIREN}00011`, raisonSociale: "Lemoine Rénovation", adresse,
  contacts: [{ nom: "Camille Test", email: "contact@exemple.fr" }],
};
const resume = { consoleClientId: "console-cli-0001", codesAutomatisation: ["tri-courriels"], palier: "palier-1", periodeMois: 6, prochaineEcheance: "2027-04-01" };
const fiche = { crmCompanyId: "crm-0001", raisonSociale: "Lemoine Rénovation", adresse, siretEtablissement: `${SIREN}00011` };
const PAYLOADS_CRM: Record<string, [unknown, string, unknown]> = {
  "entreprise.devenue_cliente": [devenue, "SIREN de 8 chiffres", { ...devenue, siren: SIREN.slice(0, 8) }],
  "entreprise.mise_a_jour": [{ crmCompanyId: "crm-0001", raisonSociale: "Lemoine Rénovation" }, "identifiant absent", { raisonSociale: "Lemoine Rénovation" }],
  "apporteur.rattache": [{ crmCompanyId: "crm-0001", apporteurId: "apporteur-0001" }, "apporteur vide", { crmCompanyId: "crm-0001", apporteurId: "" }],
  "fiche.fusionnee": [{ crmCompanyIdAbsorbee: "crm-0002", crmCompanyIdGardee: "crm-0001" }, "fiche gardée absente", { crmCompanyIdAbsorbee: "crm-0002" }],
  "consentement.retire": [personne, "e-mail en clair", { ...personne, email: "contact@exemple.fr" }],
  "effacement.demande": [personne, "e-mail en clair", { ...personne, email: "contact@exemple.fr" }],
};
const cid = { consoleClientId: "console-cli-0001" };
const PAYLOADS_CONSOLE: Record<string, [unknown, string, unknown]> = {
  "client.cree": [{ ...cid, crmCompanyId: "crm-0001" }, "fiche CRM absente", cid],
  "client.statut": [{ ...cid, statut: "dormant" }, "statut prospect", { ...cid, statut: "prospect" }],
  "plan.resume": [resume, "montant présent", { ...resume, montantHtCentimes: 1000 }],
  "renouvellement.proche": [{ ...cid, dateRenouvellement: "2027-04-01" }, "date mal formée", { ...cid, dateRenouvellement: "01/04/2027" }],
  "impaye.signale": [{ ...cid, joursRetard: 12 }, "jours négatifs", { ...cid, joursRetard: -1 }],
  "automatisation.activee": [{ ...cid, codeAutomatisation: "tri-courriels", dateActivation: "2026-11-01" }, "code vide", { ...cid, codeAutomatisation: "", dateActivation: "2026-11-01" }],
  "contrat.resilie": [{ ...cid, dateResiliation: "2027-01-31" }, "date absente", cid],
};
const lectureGet = (q: string) => `${CHEMIN_LECTURE}?${q}`;
const lectureOk = lectureGet(`siren=${SIREN}`);
export function construireFixtures(): Record<string, unknown> {
  const sortie: Record<string, unknown> = {};
  for (const [type, [ok, nomKo, ko]] of Object.entries(PAYLOADS_CRM)) {
    const c = SENS.crm.chemin;
    sortie[`${type}.json`] = { type, cas: [cas("crm", "valide", true, "POST", c, deCrm(type, ok)), cas("crm", nomKo, false, "POST", c, deCrm(type, ko))] };
  }
  for (const [type, [ok, nomKo, ko]] of Object.entries(PAYLOADS_CONSOLE)) {
    const c = SENS.console.chemin;
    sortie[`${type}.json`] = { type, cas: [cas("console", "valide", true, "POST", c, deConsole(type, ok)), cas("console", nomKo, false, "POST", c, deConsole(type, ko))] };
  }
  sortie["lecture-entreprise.json"] = {
    route: "lecture-entreprise",
    cas: [
      cas("console", "par SIREN", true, "GET", lectureOk),
      cas("console", "par SIRET", true, "GET", lectureGet(`siret=${SIREN}00011`)),
      cas("console", "SIREN de 8 chiffres", false, "GET", lectureGet(`siren=${SIREN.slice(0, 8)}`)),
      cas("console", "SIREN et SIRET ensemble", false, "GET", lectureGet(`siren=${SIREN}&siret=${SIREN}00011`)),
    ],
    reponses: [
      { nom: "fiche active", valide: true, corps: fiche },
      { nom: "fiche absorbée", valide: true, corps: { ...fiche, crmCompanyId: "crm-0002", absorbeePar: "crm-0001" } },
      { nom: "fiche absente", valide: true, statut: 404, corps: { erreur: { code: "introuvable", message: "Entreprise introuvable.", id_trace: "trace-0001" } } },
    ],
  };
  sortie["json-schema.json"] = {
    c3: {
      version: "0.1.0",
      crmVersConsole: z.toJSONSchema(EvenementCrm, { target: "draft-2020-12", unrepresentable: "any" }),
      consoleVersCrm: z.toJSONSchema(EvenementConsole, { target: "draft-2020-12", unrepresentable: "any" }),
      lectureRequete: z.toJSONSchema(LectureRequete, { target: "draft-2020-12", unrepresentable: "any" }),
      lectureReponse: z.toJSONSchema(LectureReponse, { target: "draft-2020-12", unrepresentable: "any" }),
    },
  };
  return sortie;
}
const texte = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe("fixtures signées de C3", () => {
  if (process.env.ECRIRE_FIXTURES_C3 === "1") {
    for (const [f, v] of Object.entries(construireFixtures())) writeFileSync(new URL(`fixtures/c3/${f}`, racine), texte(v));
  }
  it("[LOT0-c3] les fixtures du disque sont celles que le code construit", () => {
    for (const [f, v] of Object.entries(construireFixtures())) expect(lire(`fixtures/c3/${f}`), f).toBe(texte(v));
  });
  it("[LOT0-c3] chaque fixture est signée avec la clé de test de son sens, et sa validité est celle du schéma", () => {
    for (const [f, v] of Object.entries(construireFixtures())) {
      const { cas: liste } = v as { cas?: ReturnType<typeof cas>[] };
      for (const c of liste ?? []) {
        expect(c.secret.startsWith("TEST-NE-PAS-UTILISER-")).toBe(true);
        expect(verifier(c.secret, c.horodatage, c.methode, c.chemin, Buffer.from(c.corps), c.signature, Number(c.horodatage))).toEqual({ ok: true });
        let conforme: boolean;
        if (c.methode === "GET") {
          conforme = c.chemin.startsWith(`${CHEMIN_LECTURE}?`) && LectureRequete.safeParse(Object.fromEntries(new URLSearchParams(c.chemin.split("?")[1]))).success;
        } else {
          const schema = c.secret.includes("-crm-") ? EvenementCrm : EvenementConsole;
          const r = schema.safeParse(JSON.parse(c.corps));
          conforme = r.success && f === `${r.data.event_type}.json`;
        }
        expect(conforme, `${f} / ${c.nom}`).toBe(c.valide);
      }
    }
  });
  it("[C-550] les réponses de lecture des fixtures : fiche absorbée valide, fiche absente en 404 introuvable", () => {
    const { reponses } = construireFixtures()["lecture-entreprise.json"] as { reponses: { nom: string; statut?: number; corps: unknown }[] };
    expect(reponses.map((r) => r.nom)).toEqual(["fiche active", "fiche absorbée", "fiche absente"]);
    for (const r of reponses.filter((x) => x.statut === undefined)) expect(LectureReponse.safeParse(r.corps).success).toBe(true);
    expect(reponses[2]?.statut).toBe(404);
  });
  it("[LOT0-c3] tous les SIREN des fixtures sont dans siren-generes.json, qui est le seul fichier à les lister", () => {
    expect(SIRENS).toContain(SIREN_ABSORBE);
    const trouves = new Set<string>();
    for (const v of Object.values(construireFixtures())) {
      for (const m of JSON.stringify(v).matchAll(/\b[0-9]{9}\b|\b[0-9]{14}\b/g)) trouves.add(m[0].slice(0, 9));
    }
    for (const s of trouves) expect(SIRENS, s).toContain(s);
  });
  it("[LOT0-c3] seules les deux clés de test c3 sont utilisées, une par sens", () => {
    const secrets = new Set<string>();
    for (const v of Object.values(construireFixtures())) for (const c of (v as { cas?: { secret: string }[] }).cas ?? []) secrets.add(c.secret);
    expect([...secrets].sort()).toEqual(["TEST-NE-PAS-UTILISER-cle-c3-console-a", "TEST-NE-PAS-UTILISER-cle-c3-crm-a"]);
  });
  it("[LOT0-contrats] empreinte à jour", () => {
    expect(lire("empreintes/c3.sha256")).toBe(calculerEmpreintes(racine.pathname).c3);
  });
});
