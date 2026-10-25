import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAutomation, defauts, MigrationRefusee, migrerReglages, validerEcrans, validerReglages, verifierMigrations, type Manifeste } from "../index.ts";
import { manifesteExemple } from "../../exemples/module-exemple.ts";

const reglagesV12 = z.object({
  actionsAutomatiquesAutorisees: z.array(z.string()).default([]),
  objetAccuse: z.string().min(1).default("Bien reçu"),
  delaiHeures: z.number().int().min(1).default(24),
  relanceActive: z.boolean().default(false),
  resumeActif: z.boolean(),
  connexion: z.string().optional(),
  signature: z.object({ nom: z.string().default("L'équipe") }).default({ nom: "L'équipe" }),
});

// Migration honnête : 1.0.0 avait « sujet », 1.2.0 l'appelle « objetAccuse ».
const migrerHonnete = (depuis: string, anciens: unknown) => {
  const { sujet, ...reste } = anciens as Record<string, unknown>;
  return sujet === undefined ? { ...reste } : { ...reste, objetAccuse: sujet };
};

const fabrique = (surcharge: Partial<Record<string, unknown>> = {}) =>
  defineAutomation({ ...manifesteExemple, version: "1.2.0", reglages: reglagesV12, migrer: migrerHonnete, ...surcharge } as unknown as Manifeste);
const module12 = fabrique();
const refus = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("aucune erreur levée");
};

describe("validerReglages", () => {
  it("[B-091] un réglage hors schéma est refusé avec le nom du champ", () => {
    const r = validerReglages(module12, { resumeActif: true, couleurPerso: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs).toContainEqual(expect.objectContaining({ champ: "couleurPerso", code: "reglage.inconnu" }));
  });

  it("[B-091] attaque : un champ inconnu imbriqué est refusé avec son chemin", () => {
    const r = validerReglages(module12, { resumeActif: true, signature: { nom: "A", extra: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs[0]?.champ).toBe("signature.extra");
  });

  it("[B-091] attaque : la clé __proto__ n'entre jamais dans les réglages", () => {
    const r = validerReglages(module12, JSON.parse('{"resumeActif":true,"__proto__":{"admin":true}}'));
    expect(r.ok).toBe(false);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("[B-091] attaque : des réglages qui ne sont pas un objet sont refusés", () => {
    for (const v of [null, undefined, "x", 3, [], () => 1]) expect(validerReglages(module12, v).ok).toBe(false);
  });

  it("[B-091] les erreurs sont par champ, en français", () => {
    const r = validerReglages(module12, { resumeActif: "oui", delaiHeures: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erreurs.map((e) => e.champ).sort()).toEqual(["delaiHeures", "resumeActif"]);
      for (const e of r.erreurs) expect(e.message).toMatch(/[a-zé]/);
    }
  });

  it("[B-091] des réglages valides sont renvoyés complétés et figés", () => {
    const r = validerReglages(module12, { resumeActif: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.valeurs.delaiHeures).toBe(24);
      expect(Object.isFrozen(r.valeurs)).toBe(true);
    }
  });
});

describe("defauts et options", () => {
  it("[B-353] une option booléenne sans défaut vaut « désactivée »", () => {
    expect(defauts(module12).resumeActif).toBe(false);
  });

  it("[B-353] attaque : un défaut vrai sur une option est refusé", () => {
    const m = fabrique({ reglages: z.object({ actionsAutomatiquesAutorisees: z.array(z.string()).default([]), nouvelleOption: z.boolean().default(true) }) });
    expect(refus(() => defauts(m))).toMatchObject({ code: "defaut_option_active" });
  });

  it("[B-353] une option ajoutée en 1.1.0 vaut « désactivée » chez un client venu de 1.0.0", () => {
    const r = migrerReglages(module12, "1.0.0", { sujet: "Merci", resumeActif: true });
    expect(r.relanceActive).toBe(false);
  });
});

describe("migrerReglages", () => {
  it("[B-354] la migration 1.0.0 → 1.2.0 garde les réglages du client et remplit les nouveaux", () => {
    const r = migrerReglages(module12, "1.0.0", { sujet: "Merci", delaiHeures: 48, resumeActif: true }, ["1.0.0", "1.1.0", "1.2.0"]);
    expect(r).toMatchObject({ objetAccuse: "Merci", delaiHeures: 48, resumeActif: true, relanceActive: false });
    expect(r.signature).toEqual({ nom: "L'équipe" });
  });

  it("[B-354] la chaîne finit toujours par la version du module, même si elle manque dans la liste", () => {
    const heures = fabrique({ migrer: (v: string, a: unknown) => (v === "1.1.0" ? { ...(a as object), delaiHeures: (a as { delaiHeures: number }).delaiHeures * 60 } : a) });
    const r = migrerReglages(heures, "1.0.0", { delaiHeures: 2, resumeActif: true }, ["1.0.0", "1.1.0"]);
    expect(r.delaiHeures).toBe(120);
  });

  it("[B-354] attaque : l'objet du client n'est jamais modifié", () => {
    const entree = Object.freeze({ sujet: "Merci", resumeActif: false });
    expect(() => migrerReglages(module12, "1.0.0", entree)).not.toThrow();
    expect(entree).toEqual({ sujet: "Merci", resumeActif: false });
  });

  it("[A-171] une version sans fonction migrer depuis la précédente est refusée", () => {
    const m = { ...module12, migrer: undefined } as unknown as typeof module12;
    expect(refus(() => migrerReglages(m, "1.0.0", { resumeActif: true }))).toBeInstanceOf(MigrationRefusee);
  });

  it("[A-171] attaque : une version de départ invalide ou plus récente est refusée", () => {
    for (const depuis of ["", "1.0", "latest", "9.0.0", "1.2.0-x", "../1.0.0"]) {
      expect(refus(() => migrerReglages(module12, depuis, { resumeActif: true })), depuis).toMatchObject({ code: "migration_refusee" });
    }
  });

  it("[A-171] attaque : une migration qui lève une erreur donne migration_refusee", () => {
    const m = fabrique({ migrer: () => { throw new Error("boum"); } });
    expect(refus(() => migrerReglages(m, "1.0.0", { resumeActif: true }))).toMatchObject({ code: "migration_refusee" });
  });

  it("[A-171] attaque : une migration asynchrone ou qui ne rend pas un objet est refusée", () => {
    for (const rendu of [Promise.resolve({ resumeActif: true }), null, "x", [1], 4]) {
      const m = fabrique({ migrer: () => rendu });
      expect(refus(() => migrerReglages(m, "1.0.0", { resumeActif: true })), String(rendu)).toMatchObject({ code: "migration_refusee" });
    }
  });

  it("[A-171] attaque : une migration qui invente un champ ou une valeur invalide est refusée", () => {
    const m1 = fabrique({ migrer: (_d: string, a: object) => ({ ...a, pirate: 1 }) });
    const m2 = fabrique({ migrer: (_d: string, a: object) => ({ ...a, delaiHeures: -5 }) });
    for (const m of [m1, m2]) expect(refus(() => migrerReglages(m, "1.0.0", { resumeActif: true }))).toMatchObject({ code: "migration_refusee" });
  });

  it("[C-245] attaque : une migration ne peut pas faire entrer une adresse en dur", () => {
    const m = fabrique({ migrer: (_d: string, a: object) => ({ ...a, objetAccuse: "ecrire a marc@exemple.fr" }) });
    expect(refus(() => migrerReglages(m, "1.0.0", { resumeActif: true }))).toMatchObject({ code: "migration_refusee" });
  });
});

describe("verifierMigrations", () => {
  const exemples = [
    { version: "1.0.0", reglages: { sujet: "Merci", resumeActif: true } },
    { version: "1.1.0", reglages: { objetAccuse: "Merci", resumeActif: false } },
    { version: "1.2.0", reglages: { objetAccuse: "Merci", resumeActif: false } },
  ];
  const publiees = ["1.0.0", "1.1.0", "1.2.0"];

  it("[A-297] migrer est déterministe sur les réglages d'exemple de chaque version publiée", () => {
    expect(verifierMigrations(module12, exemples, publiees)).toEqual({ ok: true, erreurs: [] });
  });

  it("[A-297] attaque : une migration qui dépend du hasard est détectée", () => {
    const m = fabrique({ migrer: (_d: string, a: object) => ({ ...a, delaiHeures: 1 + Math.floor(Math.random() * 1000) }) });
    const r = verifierMigrations(m, exemples, publiees);
    expect(r.ok).toBe(false);
    expect(r.erreurs.join(" ")).toMatch(/déterministe/);
  });

  it("[A-297] attaque : une migration qui dépend de l'heure est détectée", () => {
    let n = 0;
    const m = fabrique({ migrer: (_d: string, a: object) => ({ ...a, delaiHeures: 1 + (n++ % 7) }) });
    expect(verifierMigrations(m, exemples, publiees).ok).toBe(false);
  });

  it("[A-297] attaque : une version publiée sans réglages d'exemple est refusée", () => {
    const r = verifierMigrations(module12, exemples.slice(1), publiees);
    expect(r.ok).toBe(false);
    expect(r.erreurs.join(" ")).toContain("1.0.0");
  });

  it("[A-297] attaque : une migration qui modifie son entrée est détectée", () => {
    const m = fabrique({ migrer: (_d: string, a: Record<string, unknown>) => { a.objetAccuse = "x"; return a; } });
    expect(verifierMigrations(m, exemples, publiees).ok).toBe(false);
  });
});

describe("références au lieu de valeurs", () => {
  const essai = (champ: string, valeur: unknown) => validerReglages(module12, { resumeActif: true, [champ]: valeur });

  it("[C-245] un réglage contenant une adresse e-mail en dur est refusé", () => {
    const r = essai("objetAccuse", "Écrire à marc@exemple.fr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs[0]).toMatchObject({ champ: "objetAccuse", code: "reglage.valeur_en_clair" });
  });

  it("[C-245] attaque : URL avec identifiant, jeton ou mot de passe en dur, même masqués", () => {
    for (const v of ["https://marc:secret@exemple.test/x", "https://exemple.test/x?token=abc123", "https://exemple.test/?api_key=abc", "sk-abcdefghijklmnopqrstuvwx", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "marc(at)exemple.fr", "marc＠exemple.fr"]) {
      expect(essai("objetAccuse", v).ok, v).toBe(false);
    }
  });

  it("[C-245] attaque : la valeur en clair est trouvée dans un objet ou une liste imbriqués", () => {
    expect(essai("signature", { nom: "a@exemple.fr" }).ok).toBe(false);
    expect(essai("actionsAutomatiquesAutorisees", ["envoyer", "x@exemple.fr"]).ok).toBe(false);
  });

  it("[C-245] attaque : un champ nommé mot de passe ou jeton n'accepte qu'une référence", () => {
    const m = fabrique({ reglages: z.object({ actionsAutomatiquesAutorisees: z.array(z.string()).default([]), motDePasse: z.string().optional(), jetonApi: z.string().optional() }) });
    expect(validerReglages(m, { motDePasse: "azerty" }).ok).toBe(false);
    expect(validerReglages(m, { jetonApi: "abc" }).ok).toBe(false);
    expect(validerReglages(m, { motDePasse: "connexion:messagerie" }).ok).toBe(true);
  });

  it("[C-245] une référence de connexion est acceptée, une fausse référence refusée", () => {
    expect(essai("connexion", "connexion:messagerie").ok).toBe(true);
    expect(essai("connexion", "connexion:").ok && essai("connexion", "connexion:../x").ok).toBe(false);
  });

  it("[C-245] attaque : un défaut du schéma qui porte une adresse en dur est refusé", () => {
    const m = fabrique({ reglages: z.object({ actionsAutomatiquesAutorisees: z.array(z.string()).default([]), copie: z.string().default("a@exemple.fr") }) });
    expect(refus(() => defauts(m))).toMatchObject({ code: "reglage.valeur_en_clair" });
  });
});

describe("modules et clients", () => {
  it("[B-352] defineAutomation refuse un code de module qui porte un identifiant de client", () => {
    for (const code of ["cli-12-accuse", "accuse-client", "accuse-123456789"]) {
      expect(() => defineAutomation({ ...manifesteExemple, code } as unknown as Manifeste), code).toThrow(/propre à un client/);
    }
  });
});

describe("un modèle, des réglages par client", () => {
  it("[A-029] deux clients utilisent le même module avec des réglages différents, sans copie", () => {
    const a = validerReglages(module12, { resumeActif: true, objetAccuse: "Merci" });
    const b = validerReglages(module12, { resumeActif: false, objetAccuse: "Bien reçu, à bientôt" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.valeurs.objetAccuse).not.toBe(b.valeurs.objetAccuse);
    expect(Object.isFrozen(module12)).toBe(true);
  });

  it("[A-290] le schéma exporté en JSON Schema 2020-12 donne les mêmes champs que les valeurs par défaut", () => {
    const schema = module12.schemaReglages as { $schema: string; properties: Record<string, unknown> };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(defauts(module12)).every((k) => k in schema.properties)).toBe(true);
  });

  it("[A-291] une action hors de la liste du client part en brouillon, une action listée part seule", () => {
    const r = validerReglages(module12, { resumeActif: false, actionsAutomatiquesAutorisees: ["classer"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const liste = r.valeurs as { actionsAutomatiquesAutorisees: string[] };
      expect(module12.classerAction(liste, "classer")).toBe("automatique");
      expect(module12.classerAction(liste, "envoyer")).toBe("brouillon");
    }
    expect(validerReglages(module12, { resumeActif: false, actionsAutomatiquesAutorisees: [3] }).ok).toBe(false);
  });

  it("[C-243] tout ce qui change d'un client à l'autre est dans le schéma exporté", () => {
    const schema = module12.schemaReglages as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(reglagesV12.shape).sort());
  });

  it("[C-244] les écrans et les tables du module sont déclarés et les écrans passent la validation", () => {
    expect(validerEcrans(module12.ecrans)).toEqual({ ok: true, erreurs: [] });
    expect(module12.tables.length).toBeGreaterThan(0);
  });
});
