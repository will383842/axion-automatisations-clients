import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifier } from "@axion-auto/contrats/src/commun/signature.ts";
import { creerModule } from "create-axion-module/src/index.ts";
import { executer } from "./index.ts";

// Les modules de test vivent sous ce paquet : ils y retrouvent le SDK et zod, sans toucher au dépôt.
const racine = mkdtempSync(join(fileURLToPath(new URL("../", import.meta.url)), ".essai-"));
const CODE = "relance-devis";
const dossier = join(racine, "modules", CODE);
const SECRET = "secret-de-test-recette";

const lancer = async (argv: string[], env: Record<string, string> = {}, options: { recetteConfiguree?: string; fetch?: typeof fetch } = {}) => {
  const sortie: string[] = [];
  const code = await executer(argv, { cwd: dossier, env, ecrire: (t) => void sortie.push(t), ...options });
  return { code, texte: sortie.join("\n") };
};

beforeAll(async () => {
  mkdirSync(join(racine, "modules"));
  // Le tsconfig.json du modèle étend la base du dépôt : on en met une vide à la racine de l'essai.
  writeFileSync(join(racine, "tsconfig.base.json"), "{}");
  await creerModule(CODE, racine);
});
afterAll(() => rmSync(racine, { recursive: true, force: true }));

describe("modèle de départ", () => {
  it("[A-288] le paquet créé s'appelle @axion-auto/<code>", () => {
    const pkg = JSON.parse(readFileSync(join(dossier, "package.json"), "utf8")) as { name: string; version: string };
    expect(pkg.name).toBe(`@axion-auto/${CODE}`);
    expect(pkg.version).toBe("0.1.0");
  });

  it("[A-289] le manifeste créé porte code, version semver et plage apiMoteur", async () => {
    const { module } = (await import(join(dossier, "src", "module.ts"))) as { module: { code: string; version: string; apiMoteur: string; jeuEssai: unknown[] } };
    expect(module.code).toBe(CODE);
    expect(module.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(module.apiMoteur).toBe("^0.2.0");
    expect(module.jeuEssai).toHaveLength(20);
  });

  it("[C-242] le modèle de départ crée un module complet : paquet, manifeste et test", () => {
    for (const f of ["package.json", "src/module.ts", "src/module.test.ts"]) expect(readFileSync(join(dossier, f), "utf8")).toContain(CODE);
  });

  it("[A-288] un code qui porte un identifiant de client est refusé", async () => {
    await expect(creerModule("client-dupont", racine)).rejects.toThrow(/code/);
  });

  it("[A-401] le module créé par le modèle passe axion-dev test sans retouche", async () => {
    const r = await lancer(["test"]);
    expect(r.texte).toContain("tests réussis");
    expect(r.code).toBe(0);
  });
});

describe("axion-dev", () => {
  it("[C-380] axion-dev essai --cas lance un seul cas", async () => {
    const r = await lancer(["essai", "--cas", "cas 3 (nominal)"]);
    expect(r.code).toBe(0);
    expect(r.texte).toContain("cas 3 (nominal)");
    expect(r.texte).toContain("1 cas joué");
    expect(r.texte).not.toContain("cas 4 (nominal)");
  });

  it("[C-380] axion-dev essai --cas inconnu est refusé", async () => {
    expect((await lancer(["essai", "--cas", "absent"])).code).toBe(1);
  });

  it("[C-380] axion-dev emballer produit un artefact signé par le signataire de test", async () => {
    const r = await lancer(["emballer"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dossier, "artefact", "signature.json"), "utf8")).toContain("ed25519");
  });

  it("[C-380] axion-dev publier sans --recette est refusé", async () => {
    const r = await lancer(["publier"], { AXION_RECETTE_URL: "http://import.recette.test/versions" });
    expect(r.code).toBe(3);
    expect(r.texte).toContain("--recette");
  });

  it("[C-380] @envoi axion-dev publier vers une adresse hors recette est refusé", async () => {
    let appels = 0;
    const faux = (async () => void appels++) as unknown as typeof fetch;
    const r = await lancer(["publier", "--recette"], { AXION_RECETTE_URL: "https://import.exemple.fr/versions", AXION_RECETTE_SECRET: SECRET }, { fetch: faux });
    expect(r.code).toBe(3);
    expect(appels).toBe(0);
  });

  it("[C-380] publier envoie un artefact signé à un faux serveur d'import et le serveur vérifie la signature HMAC", async () => {
    const recus: { cle: string; verdict: boolean; fichiers: string[] }[] = [];
    const serveur = createServer((req: IncomingMessage, rep) => {
      const morceaux: Buffer[] = [];
      req.on("data", (m: Buffer) => morceaux.push(m));
      req.on("end", () => {
        const corps = Buffer.concat(morceaux);
        const h = (n: string) => String(req.headers[n.toLowerCase()] ?? "");
        const v = verifier(SECRET, h("X-Axion-Horodatage"), req.method ?? "", req.url ?? "", corps, h("X-Axion-Signature"), Math.floor(Date.now() / 1000));
        const { fichiers } = JSON.parse(corps.toString("utf8")) as { fichiers: Record<string, string> };
        recus.push({ cle: h("Idempotency-Key"), verdict: v.ok, fichiers: Object.keys(fichiers) });
        // Première tentative refusée en panne passagère : la reprise est re-signée avec la même Idempotency-Key.
        rep.statusCode = recus.length === 1 ? 503 : 200;
        rep.end();
      });
    });
    await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}/versions`;
    try {
      const r = await lancer(["publier", "--recette"], { AXION_RECETTE_URL: url, AXION_RECETTE_SECRET: SECRET }, { recetteConfiguree: new URL(url).origin });
      expect(r.code).toBe(0);
      expect(recus).toHaveLength(2);
      expect(recus.every((x) => x.verdict)).toBe(true);
      expect(recus[0]?.cle).toBeTruthy();
      expect(recus[1]?.cle).toBe(recus[0]?.cle);
      expect(recus[1]?.fichiers).toContain("signature.json");
    } finally {
      serveur.close();
    }
  });
});

describe("corrections de relecture (tour 1)", () => {
  const depot = fileURLToPath(new URL("../../../", import.meta.url));
  const lire = (chemin: string) => readFileSync(join(depot, chemin), "utf8");

  it("[C-242] le modèle se lance par le script racine creer-module, jamais par pnpm create", () => {
    const racinePkg = JSON.parse(lire("package.json")) as { scripts: Record<string, string> };
    expect(racinePkg.scripts["creer-module"]).toBe("tsx packages/create-axion-module/src/index.ts");
    for (const f of ["packages/create-axion-module/README.md", "docs/adr/0028-modele-de-depart-et-axion-dev.md", "packages/create-axion-module/src/index.ts"]) {
      expect(lire(f)).not.toContain("pnpm create axion-module");
      if (f !== "packages/create-axion-module/src/index.ts") expect(lire(f)).toContain("pnpm creer-module");
    }
  });

  it("[C-242] les tests des modules tournent dans pnpm test et le modèle a un typecheck", () => {
    expect(lire("vitest.config.ts")).toMatch(/dossiers\("modules"\)/);
    const pkg = JSON.parse(readFileSync(join(dossier, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["typecheck"]).toContain("tsc");
    expect(readFileSync(join(dossier, "tsconfig.json"), "utf8")).toContain("tsconfig.base.json");
  });

  it("[C-394] l'adresse de recette de la configuration est lue dans AXION_RECETTE_ORIGINE", async () => {
    const recus: string[] = [];
    const serveur = createServer((req, rep) => {
      recus.push(req.url ?? "");
      req.resume();
      rep.statusCode = 200;
      rep.end();
    });
    await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}/versions`;
    try {
      const sans = await lancer(["publier", "--recette"], { AXION_RECETTE_URL: url, AXION_RECETTE_SECRET: SECRET });
      expect(sans.code).toBe(3);
      const avec = await lancer(["publier", "--recette"], { AXION_RECETTE_URL: url, AXION_RECETTE_SECRET: SECRET, AXION_RECETTE_ORIGINE: new URL(url).origin });
      expect(avec.code).toBe(0);
      expect(recus).toEqual(["/versions"]);
    } finally {
      serveur.close();
    }
  });

  it("[A-401] l'artefact signé et les restes d'essai sont ignorés par git", () => {
    const ignores = lire(".gitignore").split("\n");
    expect(ignores).toContain("artefact/");
    expect(ignores).toContain("packages/axion-dev/.essai-*");
  });
});
