import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mettreAJourInstance, type PortsMiseAJour } from "./mettre-a-jour.ts";

// Mise à jour d'une instance (T4-28b2, ADR 0125). Faux client : répond selon le texte de la requête ; les essais en base sont dans les fichiers *.int.test.ts existants.
const A = "11111111-1111-4111-8111-111111111111";
const INSTANCE = "66666666-6666-4666-8666-666666666666";
const AUTO = "55555555-5555-4555-8555-555555555555";
const V10 = "44444444-4444-4444-8444-444444444444";
const V11 = "88888888-8888-4888-8888-888888888888";
const CFG_ANCIENNE = "77777777-7777-4777-8777-777777777777";
const SCHEMA = { type: "object", properties: { delai_jours: { type: "integer" }, canal: { type: "string" } }, required: ["delai_jours", "canal"], additionalProperties: false };
type Rep = { rows: Record<string, unknown>[]; rowCount?: number };
type Options = { cible?: Record<string, unknown> | null; testReussi?: boolean; changementConcurrent?: boolean };
function fauxPool(o: Options = {}) {
  const appels: { texte: string; valeurs: unknown[] }[] = [];
  const client = {
    async query(texte: string, valeurs: unknown[] = []): Promise<Rep> {
      appels.push({ texte, valeurs });
      if (texte.includes("FROM instances AS i") && texte.includes("semver_depart")) return { rows: [{ version_courante_id: o.changementConcurrent && appels.filter((a) => a.texte.includes("FOR UPDATE")).length > 0 ? V11 : V10, automatisation_id: AUTO, etat: "active", semver_depart: "1.0.0", configuration_id: CFG_ANCIENNE, donnees: { delai_jours: 3, canal: "courriel" } }] };
      if (texte.includes("FROM versions_automatisation")) return { rows: o.cible === null ? [] : [{ id: V11, automatisation_id: AUTO, statut: "publiee", semver: "1.1.0", schema_configuration: SCHEMA, ...o.cible }] };
      if (texte.includes("FROM instances") && texte.includes("FOR UPDATE")) return { rows: [{ version_courante_id: o.changementConcurrent ? V11 : V10, configuration_id: CFG_ANCIENNE }] };
      if (texte.includes("max(numero)")) return { rows: [{ dernier: 1 }] };
      if (texte.includes("SELECT resultat FROM tests_a_blanc")) return { rows: [{ resultat: o.testReussi === false ? "echoue" : "reussi" }] };
      if (texte.includes("FROM connexions")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, appels };
}
const ecrits = (appels: { texte: string; valeurs: unknown[] }[], debut: string) => appels.filter((a) => a.texte.startsWith(debut));
function ports(o: { reglages?: Record<string, unknown> | Error; tables?: "ok" | "quarantaine"; rapport?: Record<string, unknown> } = {}) {
  const journal: string[] = [];
  const alertes: { type: string; clientId: string; instanceId: string }[] = [];
  const p: PortsMiseAJour = {
    migrateur: { async migrer(c) { journal.push(`migrer:${c.depuisSemver}->${c.versionCibleId}`); if (o.reglages instanceof Error) throw o.reglages; return o.reglages ?? { ...c.reglages, canal: "courriel" }; } },
    async tables() { journal.push("tables"); return o.tables ?? "ok"; },
    executeur: { async executer() { journal.push("a_blanc"); return { lectures: 4, brouillons: 1, envois: 0, dureeMs: 50, ...o.rapport }; } },
    alertes: { async alerter(a) { alertes.push(a); } },
  };
  return { p, journal, alertes };
}

describe("mise à jour d'une instance", () => {
  it("[A-171] la mise à jour 1.0 → 1.1 migre les réglages et garde ceux du client", async () => {
    const { pool, appels } = fauxPool();
    const { p, journal } = ports({ reglages: { delai_jours: 3, canal: "courriel" } });
    const r = await mettreAJourInstance(pool, A, INSTANCE, V11, "equipe-essai", p);
    expect(r).toEqual({ etat: "ok" });
    expect(journal).toEqual(["migrer:1.0.0->" + V11, "tables", "a_blanc"]);
    // La configuration migrée naît inactive ; l'ancienne est désactivée, jamais supprimée ni modifiée dans ses données.
    const [ligne] = ecrits(appels, "INSERT INTO configurations");
    expect(ligne?.texte).not.toMatch(/active\)? VALUES[^)]*true/i);
    expect(JSON.parse(String(ligne?.valeurs.find((v) => typeof v === "string" && v.startsWith("{"))))).toEqual({ delai_jours: 3, canal: "courriel" });
    expect(appels.some((a) => /DELETE|TRUNCATE/i.test(a.texte))).toBe(false);
    expect(ecrits(appels, "UPDATE instances SET version_courante_id")).toHaveLength(1);
    expect(ecrits(appels, "UPDATE instances SET version_courante_id")[0]?.valeurs).toContain(V11);
    expect(ecrits(appels, "INSERT INTO deploiements_instance")[0]?.valeurs).toEqual(expect.arrayContaining([A, INSTANCE, V10, V11, "ok"]));
  });

  it("[A-171] réglages migrés invalides pour la version cible : rien ne bascule, la configuration migrée reste inactive", async () => {
    const { pool, appels } = fauxPool();
    const { p, alertes, journal } = ports({ reglages: { delai_jours: "trois" } });
    const r = await mettreAJourInstance(pool, A, INSTANCE, V11, "equipe-essai", p);
    expect(r).toEqual({ etat: "echec", cause: "reglages" });
    expect(journal).not.toContain("tables");
    expect(ecrits(appels, "UPDATE instances")).toHaveLength(0);
    expect(ecrits(appels, "UPDATE configurations")).toHaveLength(0);
    expect(ecrits(appels, "INSERT INTO deploiements_instance")[0]?.valeurs).toEqual(expect.arrayContaining(["echec", "reglages"]));
    expect(alertes).toEqual([{ type: "mise_a_jour_echec", clientId: A, instanceId: INSTANCE }]);
  });

  it("[A-171] un échec du migrateur de réglages garde l'ancienne version, sans détail de l'erreur dans la trace", async () => {
    const { pool, appels } = fauxPool();
    const { p } = ports({ reglages: new Error("jeton secret-abc") });
    expect(await mettreAJourInstance(pool, A, INSTANCE, V11, "equipe-essai", p)).toEqual({ etat: "echec", cause: "reglages" });
    expect(JSON.stringify(appels)).not.toContain("secret-abc");
    expect(ecrits(appels, "UPDATE instances")).toHaveLength(0);
  });

  it("[A-171] la bascule exige un test à blanc réussi de la version cible et de la configuration migrée", async () => {
    const envoi = fauxPool();
    const a = ports({ rapport: { envois: 1 } });
    expect(await mettreAJourInstance(envoi.pool, A, INSTANCE, V11, "equipe-essai", a.p)).toEqual({ etat: "echec", cause: "test_a_blanc" });
    expect(ecrits(envoi.appels, "UPDATE instances")).toHaveLength(0);
    expect(ecrits(envoi.appels, "UPDATE configurations")).toHaveLength(0);
    // Le test échoué est rangé : version cible et configuration migrée, jamais celles de l'instance.
    expect(ecrits(envoi.appels, "INSERT INTO tests_a_blanc")[0]?.valeurs).toEqual(expect.arrayContaining([V11, "echoue"]));
    // Même si la dernière ligne lue au moment de basculer n'est pas « reussi », rien ne bascule.
    const relu = fauxPool({ testReussi: false });
    expect(await mettreAJourInstance(relu.pool, A, INSTANCE, V11, "equipe-essai", ports().p)).toMatchObject({ etat: "echec" });
    expect(ecrits(relu.appels, "UPDATE instances")).toHaveLength(0);
  });

  it("[A-171] une instance qui a changé de version pendant la mise à jour ne bascule pas", async () => {
    const { pool, appels } = fauxPool({ changementConcurrent: true });
    expect(await mettreAJourInstance(pool, A, INSTANCE, V11, "equipe-essai", ports().p)).toEqual({ etat: "echec", cause: "changement_concurrent" });
    expect(ecrits(appels, "UPDATE instances")).toHaveLength(0);
  });

  it("[A-171] une mise à jour vers une version d'une autre automatisation ou non publiée est refusée, aucune ligne ok dans deploiements_instance", async () => {
    for (const cible of [{ automatisation_id: "99999999-9999-4999-8999-999999999999" }, { statut: "depreciee" }, { id: V10 }, null]) {
      const { pool, appels } = fauxPool({ cible });
      const { p, journal } = ports();
      await expect(mettreAJourInstance(pool, A, INSTANCE, V11, "equipe-essai", p), JSON.stringify(cible)).rejects.toMatchObject({ code: "regle_metier" });
      expect(journal).toEqual([]);
      expect(ecrits(appels, "INSERT INTO deploiements_instance")).toHaveLength(0);
      expect(ecrits(appels, "UPDATE instances")).toHaveLength(0);
    }
  });

  it("[A-228] une base en quarantaine : l'instance reste sur l'ancienne version, une ligne quarantaine est écrite et une alerte part", async () => {
    const { pool, appels } = fauxPool();
    const { p, alertes, journal } = ports({ tables: "quarantaine" });
    expect(await mettreAJourInstance(pool, A, INSTANCE, V11, "equipe-essai", p)).toEqual({ etat: "quarantaine", cause: "tables" });
    expect(journal).not.toContain("a_blanc");
    expect(ecrits(appels, "UPDATE instances")).toHaveLength(0);
    expect(ecrits(appels, "INSERT INTO deploiements_instance")[0]?.valeurs).toEqual(expect.arrayContaining(["quarantaine", "tables"]));
    expect(alertes).toEqual([{ type: "mise_a_jour_echec", clientId: A, instanceId: INSTANCE }]);
  });

  it("[A-228] échec de migration : l'instance reste sur 1.0 et une alerte part", async () => {
    const { pool, appels } = fauxPool();
    const { p, alertes } = ports({ reglages: new Error("x") });
    const r = await mettreAJourInstance(pool, A, INSTANCE, V11, "equipe-essai", p);
    expect(r.etat).toBe("echec");
    expect(ecrits(appels, "UPDATE instances")).toHaveLength(0);
    expect(alertes).toHaveLength(1);
  });

  it("[A-171] le code du module n'est jamais chargé dans l'API (migrerReglages passe par le port du bac à sable)", () => {
    const dossier = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dossier).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(5);
    for (const f of sources) {
      const texte = readFileSync(dossier + f, "utf8").replace(/\/\/.*$/gm, "");
      expect(texte, f).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\bnew\s+Function\b|\beval\s*\(|\bvm\./);
    }
  });
});
