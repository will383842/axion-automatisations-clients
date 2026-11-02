import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Brique, type ModuleExecutable, versEvenements } from "./contrat.ts";
import { RESEAUX_PERMIS, argumentsConteneur, creerModuleEnveloppe } from "./lancer.ts";

const EMPREINTE = `sha256:${"a".repeat(64)}`;
const FICHE = { nom: "m", champs: ["objet"], evenements: ["traite"] };
const brique: Brique = { nom: "outil-exemple", image: "ghcr.io/exemple/outil", version: "1.2.3", empreinte: EMPREINTE, licence: "MIT" };

describe("module enveloppe", () => {
  it("[A-309] l'image est épinglée par empreinte : étiquette mobile ou empreinte absente refusée", () => {
    expect(() => argumentsConteneur({ ...brique, empreinte: "latest" })).toThrow(/empreinte/);
    expect(() => argumentsConteneur({ ...brique, version: "latest" })).toThrow(/latest/);
    expect(() => argumentsConteneur({ ...brique, licence: "" })).toThrow(/licence/);
    expect(argumentsConteneur(brique)).toContain(`ghcr.io/exemple/outil@${EMPREINTE}`);
  });
  it("[A-331] @isolation le conteneur enveloppe n'a aucun réseau (none) et ne joint ni OpenBao ni le courtier", () => {
    const a = argumentsConteneur(brique);
    expect(a).toContain("--read-only");
    expect(a).toContain("--cap-drop=ALL");
    expect(a).toContain("--security-opt=no-new-privileges");
    expect(a).toContain("--network=none");
    expect(a.join(" ")).not.toMatch(/openbao|courtier|\s-e\s|--env|--volume|\s-v\s|--mount|--privileged|docker\.sock|--network=(host|sortie|default|enveloppe)/);
    for (const r of ["sortie", "openbao", "enveloppe", "host", "bridge", "default", "socle_enveloppe", "container:abc"]) expect(() => argumentsConteneur(brique, { reseau: r }), r).toThrow(/réseau/);
  });
  it("[A-331] la liste des réseaux permis est fermée : seul « none », jamais un réseau partagé entre exécutions", () => {
    expect(RESEAUX_PERMIS).toEqual(["none"]);
    expect(() => argumentsConteneur(brique, { reseau: "none" })).not.toThrow();
  });
  it("limites de ressources : mémoire, swap, processus, processeur", () => {
    const a = argumentsConteneur(brique);
    for (const m of [/^--memory=\d+m$/, /^--memory-swap=\d+m$/, /^--pids-limit=\d+$/, /^--cpus=\d+(\.\d+)?$/]) expect(a.some((x) => m.test(x)), String(m)).toBe(true);
    expect(a.find((x) => x.startsWith("--memory="))?.slice(9)).toBe(a.find((x) => x.startsWith("--memory-swap="))?.slice(14));
  });
  it("brique.image : dépôt sans « : », sans « @ » et sans tiret initial", () => {
    for (const mauvaise of ["--privileged", "-v", "ghcr.io/exemple/outil:1.2", "ghcr.io/exemple/outil@sha256:abc", "Exemple/Outil", "", "ghcr.io/exemple/ou til"]) {
      expect(() => argumentsConteneur({ ...brique, image: mauvaise }), mauvaise).toThrow(/image/);
    }
  });
  it("version « LATEST » refusée quelle que soit la casse", () => {
    expect(() => argumentsConteneur({ ...brique, version: "LATEST" })).toThrow(/latest/i);
    expect(() => argumentsConteneur({ ...brique, version: "Latest" })).toThrow(/latest/i);
  });
  it("le schéma des briques porte le même motif pour image", () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../ops/briques/schema.json", import.meta.url)), "utf8"));
    expect(new RegExp(schema.properties.image.pattern).test("ghcr.io/exemple/outil")).toBe(true);
    for (const m of ["-v", "a:1", "a@sha256:x"]) expect(new RegExp(schema.properties.image.pattern).test(m), m).toBe(false);
  });
  it("le lanceur tient un délai maximal : exécution interrompue et refusée", async () => {
    let signal: AbortSignal | undefined;
    const lent = creerModuleEnveloppe(brique, FICHE, (_a, _e, s) => {
      signal = s;
      return new Promise(() => {});
    }, { delaiMs: 20 });
    await expect(lent.executer({})).rejects.toThrow(/délai/);
    expect(signal?.aborted).toBe(true);
  });
  it("un module enveloppe et un module en code produisent les mêmes événements pour le même cas d'essai", async () => {
    const cas = { objet: "devis", quantite: 3 };
    const enCode: ModuleExecutable = { fiche: FICHE, executer: async (e) => ({ evenements: [{ type: "traite", donnees: e }] }) };
    const enveloppe = creerModuleEnveloppe(brique, FICHE, async (_args, entree) => ({ evenements: [{ type: "traite", donnees: entree }] }));
    expect(versEvenements(await enveloppe.executer(cas), FICHE.evenements)).toEqual(versEvenements(await enCode.executer(cas), FICHE.evenements));
  });
  it("[A-310] passer d'une option à l'autre ne change rien côté client : même fiche de connexion, même forme d'événement", async () => {
    const enveloppe = creerModuleEnveloppe(brique, FICHE, async () => ({ evenements: [{ type: "traite", donnees: {} }] }));
    expect(enveloppe.fiche).toEqual(FICHE);
    expect(Object.keys(enveloppe).sort()).toEqual(["executer", "fiche"]);
    await expect(creerModuleEnveloppe(brique, enveloppe.fiche, async () => ({ evenements: [{ type: "", donnees: {} }] })).executer({})).rejects.toThrow(/événement/);
  });
  it("la sortie du lanceur est validée : tableau, type déclaré, données objet simple, clés interdites écartées", async () => {
    const lancer = (sortie: unknown) => creerModuleEnveloppe(brique, FICHE, async () => sortie as never).executer({});
    await expect(lancer({ evenements: "x" })).rejects.toThrow(/événement/);
    await expect(lancer({ evenements: [{ type: "inconnu", donnees: {} }] })).rejects.toThrow(/déclaré/);
    await expect(lancer({ evenements: [{ type: "traite", donnees: [1] }] })).rejects.toThrow(/objet/);
    await expect(lancer({ evenements: [{ type: "traite", donnees: null }] })).rejects.toThrow(/objet/);
    for (const cle of ["client", "tenant_id"]) await expect(lancer({ evenements: [{ type: "traite", donnees: { a: { [cle]: "x" } } }] })).rejects.toThrow(/interdite/);
    await expect(lancer({ evenements: [{ type: "traite", donnees: JSON.parse('{"__proto__": {"x": 1}}') }] })).rejects.toThrow(/interdite/);
    await expect(lancer({ evenements: [{ type: "traite", donnees: { f: () => 1 } }] })).rejects.toThrow(/JSON/);
    const ok = await lancer({ evenements: [{ type: "traite", donnees: { a: 1, b: [1, "x", null] }, extra: "ignoré" }] });
    expect(ok.evenements).toEqual([{ type: "traite", donnees: { a: 1, b: [1, "x", null] } }]);
  });
});
