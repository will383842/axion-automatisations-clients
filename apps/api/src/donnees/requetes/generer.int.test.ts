import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../../scripts/garde-compose.js";
import { journalEchecs } from "../../provisionnement/journal-echecs.js";
import { genererSql } from "./generer.js";
import { premieresRequetes } from "./premieres.js";
import { declarer, schemaParametres } from "./structure.js";
journalEchecs(import.meta.url);

// Essai réel (job socle-integration, Docker) : le SQL généré, sur un vrai PostgreSQL à deux établissements, ne rend que les lignes de l'établissement de la SESSION (B-173, C-536).
// Aucun résultat n'est inventé hors CI : cet essai n'a pas été lancé en local (pas de Docker).
const racine = (chemin: string) => fileURLToPath(new URL(`../../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
let conteneur = "";
let pool!: pg.Pool;
const A = randomUUID();
const B = randomUUID();
const trace = (m: string) => writeSync(2, `GENERER-INT ${m}\n`);

beforeAll(async () => {
  const image = (lireYaml(readFileSync(racine("ops/socle/compose.postgres.yml"), "utf8")) as unknown as { services: Record<string, { image: string }> }).services["postgres"]!.image;
  const mdp = randomBytes(16).toString("hex");
  conteneur = docker("run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${mdp}`, image);
  const hote = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", conteneur).split(" ")[0] ?? "";
  pool = new pg.Pool({ host: hote, user: "postgres", password: mdp, database: "postgres", max: 2 });
  for (let i = 0; ; i++) {
    try { await pool.query("SELECT 1"); break; } catch (e) {
      if (i > 90) { trace(`PostgreSQL non démarré : ${(e as Error).name}`); throw e; }
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  for (const morceau of readFileSync(racine("apps/api/drizzle-cli/0000_modele_base_client.sql"), "utf8").split("--> statement-breakpoint")) if (morceau.trim()) await pool.query(morceau);
  for (const e of [A, B]) {
    await pool.query("INSERT INTO commun.etablissements (id, nom) VALUES ($1, 'Atelier Bertin')", [e]);
    await pool.query("INSERT INTO commun.personnes (etablissement_id, nom) VALUES ($1, 'Bertin'), ($1, 'Rivoire')", [e]);
    await pool.query("INSERT INTO commun.listes_prospects (etablissement_id, nom) VALUES ($1, $2)", [e, e === A ? "liste-a" : "liste-b"]);
    await pool.query("INSERT INTO commun.index_fichiers (etablissement_id, cle_objet, empreinte, taille_octets, type_contenu) VALUES ($1, 'a', $2, 100, 'text/plain')", [e, "0".repeat(64)]);
  }
}, 120_000);
afterAll(async () => {
  await pool?.end().catch(() => undefined);
  if (conteneur) try { docker("rm", "-f", conteneur); } catch { /* déjà arrêté */ }
});

describe("SQL généré sur une vraie base à deux établissements", () => {
  it("[B-173] @isolation chaque requête livrée ne rend que les lignes de l'établissement de la session, et EXPLAIN passe", async () => {
    for (const r of Object.values(premieresRequetes())) {
      const g = genererSql(r, schemaParametres(r).parse({}) as Record<string, unknown>, [A]);
      await pool.query(`EXPLAIN ${g.texte}`, g.valeurs);
      const lignes = (await pool.query(g.texte, g.valeurs)).rows as Record<string, unknown>[];
      if (r.nom === "compterPersonnes") expect(lignes[0]).toEqual({ total: 2 });
      if (r.nom === "listerListesProspects") expect(lignes.map((l) => l["nom"])).toEqual(["liste-a"]);
      if (r.nom === "etatDonnees") expect(lignes[0]).toEqual({ personnes: 2, taille_fichiers: 100 });
      expect(JSON.stringify(lignes), r.nom).not.toContain("liste-b");
    }
  });

  it("[B-173] @isolation une valeur hostile ne rend aucune ligne d'un autre établissement", async () => {
    const r = declarer({ nom: "chercher", mode: "lecture", metadonnees: false, parametres: { q: { type: "texte", max: 200 } }, forme: { type: "simple", table: "commun.listes_prospects", sortie: { lignes: [{ colonne: "nom" }] }, filtres: [{ colonne: "nom", operateur: "egal", parametre: "q" }], limite: { fixe: 10 } } });
    for (const q of ["' OR true --", "liste-b", "x' UNION SELECT nom FROM commun.listes_prospects --"]) {
      const g = genererSql(r, schemaParametres(r).parse({ q }) as Record<string, unknown>, [A]);
      expect((await pool.query(g.texte, g.valeurs)).rows, q).toEqual([]);
    }
  });
});
