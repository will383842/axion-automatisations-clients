import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lireYaml, verifierCompose } from "../../../../scripts/garde-compose.ts";

const chemin = fileURLToPath(new URL("../../../../ops/socle/compose.executeur.yml", import.meta.url));
const texte = readFileSync(chemin, "utf8");

describe("réseaux de l'exécuteur", () => {
  it("[A-330] @isolation executeur-interne n'a aucune sortie et le fichier passe la garde du compose", () => {
    expect(verifierCompose("compose.executeur.yml", texte)).toEqual([]);
    const doc = lireYaml(texte) as { networks?: Record<string, { internal?: string }> };
    expect(doc.networks?.["executeur-interne"]?.internal).toBe("true");
    expect(doc.networks?.["sortie"]?.internal).not.toBe("true");
  });

  it("[A-330] le fichier ne porte ni adresse, ni identifiant, ni variable de la base console", () => {
    expect(texte).not.toMatch(/console|postgres|pgbouncer|DATABASE|DB_|PG(HOST|PASSWORD|USER)/i);
  });
});
