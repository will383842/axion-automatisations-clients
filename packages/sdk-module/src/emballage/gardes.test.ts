import { describe, expect, it } from "vitest";
import { verifierLicences, verifierProvenance, verifierCode, type Paquet } from "./gardes.ts";

const p = (nom: string, licence: string | undefined, version = "1.0.0"): Paquet => ({ nom, version, licence });

describe("gardes d'emballage", () => {
  it("[C-471] une dépendance AGPL est refusée", () => {
    expect(verifierLicences([p("outil", "AGPL-3.0-only")])).toEqual([{ regle: "licence", paquet: "outil" }]);
  });

  it("[C-471] une licence « non commerciale » est refusée", () => {
    expect(verifierLicences([p("outil", "CC-BY-NC-4.0"), p("autre", "Usage non commercial")]).map((v) => v.paquet)).toEqual(["outil", "autre"]);
  });

  it("[C-471] une licence inconnue ou absente est refusée", () => {
    expect(verifierLicences([p("a", undefined), p("b", "SEE LICENSE IN LICENSE.md")]).length).toBe(2);
  });

  it("[C-471] « MIT AND AGPL-3.0-only » est refusé, « MIT OR AGPL-3.0-only » est accepté", () => {
    expect(verifierLicences([p("a", "MIT AND AGPL-3.0-only")]).length).toBe(1);
    expect(verifierLicences([p("b", "MIT OR AGPL-3.0-only")])).toEqual([]);
  });

  it("[C-471] les six licences du livre sont acceptées", () => {
    const livre = ["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "PostgreSQL"];
    expect(verifierLicences(livre.map((l, i) => p(`p${i}`, l)))).toEqual([]);
  });

  it("[C-492] n8n, n8n-* et @n8n/* sont refusés", () => {
    const noms = ["n8n", "n8n-core", "@n8n/config"];
    expect(verifierProvenance(noms.map((n) => p(n, "MIT"))).map((v) => v.paquet)).toEqual(noms);
  });

  it("[C-492] un paquet d'éditeur visuel est refusé", () => {
    expect(verifierProvenance([p("node-red", "Apache-2.0"), p("@node-red/runtime", "Apache-2.0")]).length).toBe(2);
    expect(verifierProvenance([p("zod", "MIT")])).toEqual([]);
  });

  it("[A-302] une clé en dur est refusée et le message ne la contient pas", () => {
    const cle = "AKIA" + "IOSFODNN7EXAMPLE";
    const v = verifierCode(`const k = "${cle}";`, []);
    expect(v.length).toBe(1);
    expect(JSON.stringify(v)).not.toContain(cle);
  });

  it("[A-302] une adresse e-mail réelle est refusée, @exemple.fr et .test sont permises", () => {
    const reelle = "contact" + "@" + "example.com";
    expect(verifierCode(`x("${reelle}")`, []).length).toBe(1);
    expect(verifierCode(`x("a@exemple.fr"); y("b@boite.test")`, [])).toEqual([]);
    expect(JSON.stringify(verifierCode(`x("${reelle}")`, []))).not.toContain(reelle);
  });

  it("[A-302] une URL avec identifiant est refusée sans être recopiée", () => {
    const url = "https://" + "jean:motdepasse" + "@hote-fictif.test/x";
    const v = verifierCode(`fetch("${url}")`, []);
    expect(v.length).toBe(1);
    expect(JSON.stringify(v)).not.toContain("motdepasse");
  });

  it("[A-302] un chemin absolu de la machine dans le code est refusé", () => {
    expect(verifierCode("// /srv/travail/projet/module.ts", ["/srv/travail/projet"]).length).toBe(1);
  });

  it("[A-302] une racine « / » ne fait pas refuser tout module, et /tmp n'est pas pris pour /tmpfs", () => {
    expect(verifierCode("// /usr/lib/x", ["/"])).toEqual([]);
    expect(verifierCode("// /tmpfs/x", ["/tmp"])).toEqual([]);
    expect(verifierCode("// /tmp/x", ["/tmp"]).length).toBe(1);
  });
});
