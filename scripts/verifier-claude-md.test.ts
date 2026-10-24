import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const chemin = fileURLToPath(new URL("../CLAUDE.md", import.meta.url));
const existe = existsSync(chemin);
const texte = existe ? readFileSync(chemin, "utf8") : "";
const lignes = texte.split("\n");
if (lignes.at(-1) === "") lignes.pop();

const titres = [
  "Ce qu'est le dépôt",
  "Interdits absolus",
  "Consignes de routine",
  "Méthode",
  "Contrats",
  "Commandes",
  "Le texte des exigences",
  "Carte des dossiers",
];

describe("[C-392] contrôle de CLAUDE.md", () => {
  it("[C-392] CLAUDE.md existe", () => {
    expect(existe).toBe(true);
  });

  it("[C-392] CLAUDE.md fait au plus 150 lignes", () => {
    expect(lignes.length).toBeLessThanOrEqual(150);
  });

  it.each(titres.map((t, i) => [i + 1, t] as const))("[C-392] titre %i présent : %s", (_n, titre) => {
    expect(lignes.some((l) => /^## /.test(l) && l.includes(titre))).toBe(true);
  });

  it("[C-392] aucun symbole €", () => {
    expect(texte).not.toContain("€");
  });

  it("[C-392] aucune adresse IPv4", () => {
    expect(texte).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it("[C-392] « @ » seulement avec exemple.fr ou .test", () => {
    const arobases = [...texte.matchAll(/\S*@\S*/g)].map((m) => m[0]);
    const interdits = arobases.filter((a) => !/@[\w.-]*exemple\.fr|@[\w.-]*\.test/.test(a));
    expect(interdits).toEqual([]);
  });
});
