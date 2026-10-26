import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classerServeur } from "./erreurs.ts";

type Ligne = { nom: string; erreur: Record<string, unknown>; classe: string; code: string };
const lignes = JSON.parse(readFileSync(fileURLToPath(new URL("../enregistrements/erreurs-serveur.json", import.meta.url)), "utf8")) as Ligne[];
const contexte = { maintenant: Date.parse("2026-10-26T08:00:00Z"), attenteQuotaMs: 3_600_000 };

describe("classement des erreurs du serveur de messagerie", () => {
  for (const l of lignes) {
    it(`[A-389] ${l.nom} est classée « ${l.classe} »`, () => {
      const e = classerServeur(Object.assign(new Error(String(l.erreur.message ?? "x")), l.erreur), contexte);
      expect([e.classe, e.code]).toEqual([l.classe, l.code]);
    });
  }
  it("[A-389] un quota sans date reçoit l'attente par défaut de la politique", () => {
    const e = classerServeur(Object.assign(new Error("x"), lignes.find((l) => l.nom === "smtp_421")?.erreur), contexte);
    expect(e.details.reprise).toBe("2026-10-26T09:00:00.000Z");
  });
  it("[A-335] le message d'une erreur ne contient jamais le texte brut du serveur", () => {
    const e = classerServeur(Object.assign(new Error("secret-du-serveur"), { code: "EAUTH", responseCode: 535, response: "secret-du-serveur" }), contexte);
    expect(JSON.stringify([e.message, e.code, e.details])).not.toContain("secret-du-serveur");
  });
});
