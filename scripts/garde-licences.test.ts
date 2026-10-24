import { describe, expect, it } from "vitest";
import { verifierLicences } from "./garde-licences.js";

const paquet = (name: string) => [{ name, versions: ["1.0.0"] }];

describe("garde-licences", () => {
  it("accepte les licences permises", () => {
    const data = { MIT: paquet("a"), "Apache-2.0": paquet("b"), "BSD-3-Clause": paquet("c"), ISC: paquet("d"), "0BSD": paquet("e"), "OFL-1.1": paquet("f") };
    expect(verifierLicences(data, new Set())).toEqual([]);
  });
  it("refuse une licence hors liste", () => {
    expect(verifierLicences({ "GPL-3.0": paquet("x") }, new Set()).join("\n")).toContain("x");
  });
  it("refuse une licence inconnue", () => {
    expect(verifierLicences({ Unknown: paquet("y") }, new Set()).join("\n")).toContain("y");
  });
  it("MPL-2.0 seulement pour les paquets de apps/api et apps/executeur", () => {
    expect(verifierLicences({ "MPL-2.0": paquet("m") }, new Set(["m"]))).toEqual([]);
    expect(verifierLicences({ "MPL-2.0": paquet("m") }, new Set(["autre"]))).not.toEqual([]);
  });
  it("lit une expression OR : une branche permise suffit", () => {
    expect(verifierLicences({ "(MIT OR GPL-3.0)": paquet("z") }, new Set())).toEqual([]);
    expect(verifierLicences({ "(MIT AND GPL-3.0)": paquet("z") }, new Set())).not.toEqual([]);
  });
});

describe("garde-licences : exceptions nommées (dépendances de développement)", () => {
  const dev = { "Python-2.0": paquet("argparse"), "BlueOak-1.0.0": paquet("minimatch") };
  it("accepte argparse (Python-2.0) et minimatch (BlueOak-1.0.0) quand ce sont des dépendances de développement", () => {
    expect(verifierLicences(dev, new Set(), new Set(["eslint"]))).toEqual([]);
  });
  it("refuse un paquet non listé, même en développement", () => {
    expect(verifierLicences({ "Python-2.0": paquet("autre") }, new Set(), new Set())).not.toEqual([]);
  });
  it("refuse la même licence sur un autre paquet que celui nommé", () => {
    expect(verifierLicences({ "BlueOak-1.0.0": paquet("argparse") }, new Set(), new Set())).not.toEqual([]);
  });
  it("refuse argparse ou minimatch quand ils sont une dépendance de production", () => {
    expect(verifierLicences(dev, new Set(), new Set(["argparse", "minimatch"]))).toHaveLength(2);
  });
});

describe("garde-licences : exception MIT-0 nommée pour nodemailer (ADR 0008)", () => {
  it("accepte nodemailer (MIT-0) quand c'est une dépendance de développement", () => {
    expect(verifierLicences({ "MIT-0": paquet("nodemailer") }, new Set(), new Set(["eslint"]))).toEqual([]);
  });
  it("refuse toute autre dépendance en MIT-0", () => {
    expect(verifierLicences({ "MIT-0": paquet("autre") }, new Set(), new Set())).toHaveLength(1);
  });
  it("refuse nodemailer quand c'est une dépendance de production", () => {
    expect(verifierLicences({ "MIT-0": paquet("nodemailer") }, new Set(), new Set(["nodemailer"]))).toHaveLength(1);
  });
});

describe("garde-licences : expressions composées", () => {
  const refuse = (expr: string) => verifierLicences({ [expr]: paquet("z") }, new Set()).length;
  it("refuse GPL-3.0-only AND (MIT OR Apache-2.0)", () => {
    expect(refuse("GPL-3.0-only AND (MIT OR Apache-2.0)")).toBe(1);
  });
  it("accepte (MIT OR Apache-2.0) AND ISC et MIT OR GPL-3.0-only", () => {
    expect(refuse("(MIT OR Apache-2.0) AND ISC")).toBe(0);
    expect(refuse("MIT OR GPL-3.0-only")).toBe(0);
  });
  it("AND lie plus fort que OR : GPL-3.0-only AND MIT OR ISC se lit (GPL AND MIT) OR ISC", () => {
    expect(refuse("GPL-3.0-only AND MIT OR ISC")).toBe(0);
    expect(refuse("GPL-3.0-only OR (GPL-2.0-only AND MIT)")).toBe(1);
  });
  it("refuse une expression illisible", () => {
    expect(refuse("(MIT OR")).toBe(1);
    expect(refuse("MIT MIT")).toBe(1);
  });
});
