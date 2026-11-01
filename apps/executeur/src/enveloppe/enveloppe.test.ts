import { describe, expect, it } from "vitest";
import { type Brique, type ModuleExecutable, versEvenements } from "./contrat.ts";
import { argumentsConteneur, creerModuleEnveloppe } from "./lancer.ts";

const EMPREINTE = `sha256:${"a".repeat(64)}`;
const brique: Brique = { nom: "outil-exemple", image: "ghcr.io/exemple/outil", version: "1.2.3", empreinte: EMPREINTE, licence: "MIT" };

describe("module enveloppe", () => {
  it("[A-309] l'image est épinglée par empreinte : étiquette mobile ou empreinte absente refusée", () => {
    expect(() => argumentsConteneur({ ...brique, empreinte: "latest" })).toThrow(/empreinte/);
    expect(() => argumentsConteneur({ ...brique, version: "latest" })).toThrow(/latest/);
    expect(() => argumentsConteneur({ ...brique, licence: "" })).toThrow(/licence/);
    expect(argumentsConteneur(brique)).toContain(`ghcr.io/exemple/outil@${EMPREINTE}`);
  });
  it("[A-331] @isolation le conteneur enveloppe ne joint ni OpenBao ni le courtier", () => {
    const a = argumentsConteneur(brique);
    expect(a).toContain("--read-only");
    expect(a).toContain("--cap-drop=ALL");
    expect(a).toContain("--security-opt=no-new-privileges");
    expect(a).toContain("--network=enveloppe");
    expect(a.join(" ")).not.toMatch(/openbao|courtier|\s-e\s|--env|--volume|\s-v\s|--mount|--privileged|docker\.sock|--network=(host|sortie|default)/);
    expect(() => argumentsConteneur(brique, { reseau: "sortie" })).toThrow(/réseau/);
    expect(() => argumentsConteneur(brique, { reseau: "openbao" })).toThrow(/réseau/);
  });
  it("[A-308] un module enveloppe et un module en code produisent les mêmes événements pour le même cas d'essai", async () => {
    const cas = { objet: "devis", quantite: 3 };
    const enCode: ModuleExecutable = { fiche: { nom: "m", champs: ["objet"] }, executer: async (e) => ({ evenements: [{ type: "traite", donnees: e }] }) };
    const enveloppe = creerModuleEnveloppe(brique, { nom: "m", champs: ["objet"] }, async (_args, entree) => ({ evenements: [{ type: "traite", donnees: entree }] }));
    expect(versEvenements(await enveloppe.executer(cas))).toEqual(versEvenements(await enCode.executer(cas)));
  });
  it("[A-310] passer d'une option à l'autre ne change rien côté client : même fiche de connexion, même forme d'événement", async () => {
    const enveloppe = creerModuleEnveloppe(brique, { nom: "m", champs: ["objet"] }, async () => ({ evenements: [{ type: "traite", donnees: {} }] }));
    expect(enveloppe.fiche).toEqual({ nom: "m", champs: ["objet"] });
    expect(Object.keys(enveloppe).sort()).toEqual(["executer", "fiche"]);
    await expect(creerModuleEnveloppe(brique, enveloppe.fiche, async () => ({ evenements: [{ type: "", donnees: {} }] })).executer({})).rejects.toThrow(/événement/);
  });
});
