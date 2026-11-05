import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { LISTE_BLANCHE, verifierListeBlanche } from "./requetes/liste.js";
import { declarer } from "./requetes/structure.js";
import { creerServiceDonnees, type Connexion, type PortsDonnees, type SessionDonnees } from "./service.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ETAB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T0 = new Date("2026-11-02T10:00:00Z");

interface Appel { base: string; role: string; texte: string; valeurs: unknown[] }
function monde(etats: Record<string, string> = {}, lignes: Record<string, unknown>[] = [{ total: 3, id: "x", nom: "Liste", cree_le: "t", secret: "non" }]) {
  const appels: Appel[] = [];
  const ouvertures: { base: string; role: string }[] = [];
  const vues = new Map<string, { expireLe: Date }>();
  const ports: PortsDonnees = {
    async base(tenantId) {
      const etat = etats[tenantId] ?? "active";
      return tenantId === A || tenantId === B ? { nomBase: `cli_${tenantId.slice(0, 4)}`, etat: etat as never } : undefined;
    },
    async ouvrir(base, role): Promise<Connexion> {
      ouvertures.push({ base, role });
      return {
        async requete(texte, valeurs) {
          appels.push({ base, role, texte, valeurs });
          return texte.includes("commun.etablissements") ? [{ id: ETAB_A }] : lignes;
        },
        async fermer() {},
      };
    },
    accordValide: async () => true,
    vueRangee: (acteur, tenantId) => vues.get(`${acteur}|${tenantId}`),
    maintenant: () => T0,
  };
  return { appels, ouvertures, service: creerServiceDonnees(ports), vues };
}
const client = (tenantId = A, etablissements = [ETAB_A]): SessionDonnees => ({ tenantId, role: "client", acteur: "u1", etablissements });
const equipe = (extra: Partial<SessionDonnees> = {}): SessionDonnees => ({ tenantId: A, role: "equipe", acteur: "e1", etablissements: [], ...extra });
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ErreurApi).code;

describe("service des données client", () => {
  it("[A-170] le portail et la console lisent la base client seulement par le service des données", async () => {
    const { service, ouvertures } = monde();
    expect((await service.executer(client(), "compterPersonnes", {}))[0]).toEqual({ total: 3 });
    expect(ouvertures).toEqual([{ base: "cli_1111", role: "lecture" }]);
    const racine = fileURLToPath(new URL("../../../../apps", import.meta.url));
    const fichiers = (d: string): string[] => readdirSync(d).flatMap((f) => (f === "node_modules" ? [] : statSync(join(d, f)).isDirectory() ? fichiers(join(d, f)) : [join(d, f)]));
    const interdit = /from\s+["'](pg|postgres|drizzle-orm[^"']*|@neondatabase[^"']*)["']|require\(\s*["']pg["']|import\(\s*["'](pg|postgres)["']|postgres(ql)?:\/\/|cli_[0-9a-f]{12}_app/;
    for (const app of ["console", "portail"]) {
      const dossier = fichiers(join(racine, app)).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
      expect(dossier.length, `aucun fichier lu pour ${app}`).toBeGreaterThan(0);
      for (const f of dossier) expect(readFileSync(f, "utf8"), f).not.toMatch(interdit);
    }
  });

  it("[B-172] une requête hors liste blanche est refusée", async () => {
    const { service, ouvertures } = monde();
    expect(await code(service.executer(client(), "requeteInconnue", {}))).toBe("schema_invalide");
    expect(await code(service.executer(client(), "constructor", {}))).toBe("schema_invalide");
    expect(await code(service.executer(client(), "listerListesProspects", { limite: "1; DROP TABLE commun.personnes" }))).toBe("schema_invalide");
    expect(await code(service.executer(client(), "listerListesProspects", { limite: [1, 2] }))).toBe("schema_invalide");
    expect(ouvertures).toEqual([]);
  });

  it("[C-536] @isolation la base est choisie d'après la session ; un identifiant de client dans la requête est ignoré", async () => {
    const { service, appels } = monde();
    await service.executer(client(A), "compterPersonnes", { tenantId: B, nomBase: "cli_2222", base: "cli_2222", clientId: B });
    expect(appels.map((a) => a.base)).toEqual(["cli_1111"]);
    expect(JSON.stringify(appels.map((a) => a.valeurs))).not.toContain(B);
  });

  it("[C-536] @isolation deux clients simultanés ne partagent ni connexion ni base", async () => {
    const { service, appels, ouvertures } = monde();
    await Promise.all([service.executer(client(A), "compterPersonnes", {}), service.executer(client(B, [ETAB_B]), "compterPersonnes", {}), service.executer(client(A), "compterPersonnes", {})]);
    expect(new Set(ouvertures.map((o) => o.base))).toEqual(new Set(["cli_1111", "cli_2222"]));
    expect(ouvertures.length).toBe(2);
    expect(appels.filter((a) => a.base === "cli_2222").every((a) => a.valeurs.flat().includes(ETAB_B) && !a.valeurs.flat().includes(ETAB_A))).toBe(true);
  });

  it("[C-536] @isolation une base gelée, exportée, à l'écart, effacée, en création ou inconnue répond introuvable", async () => {
    for (const etat of ["gelee", "exportee", "a_l_ecart", "effacee", "en_creation"]) {
      const { service, ouvertures } = monde({ [A]: etat });
      expect(await code(service.executer(client(A), "compterPersonnes", {})), etat).toBe("introuvable");
      expect(ouvertures).toEqual([]);
    }
    expect(await code(monde().service.executer(client("33333333-3333-4333-8333-333333333333"), "compterPersonnes", {}))).toBe("introuvable");
  });

  it("[B-173] @isolation le filtre d'établissement est imposé par le service ; un paramètre ne le contourne pas", async () => {
    const { service, appels } = monde();
    await service.executer(client(A, [ETAB_A]), "listerListesProspects", { limite: 5, etablissements: [ETAB_B], etablissement_id: ETAB_B, etablissementId: ETAB_B });
    const a = appels[0]!;
    expect(a.texte).toContain('"t"."etablissement_id" = ANY($1::uuid[])');
    expect(a.valeurs).toEqual([[ETAB_A], 5]);
    await service.executer(client(A, []), "compterPersonnes", {});
    expect(appels[1]!.valeurs).toEqual([[]]);
  });

  it("[B-173] une déclaration avec un champ sql, un nom qui n'est pas sa clé ou une écriture est refusée au chargement", () => {
    const base = { nom: "x", mode: "lecture", metadonnees: true, parametres: {}, forme: { type: "simple", table: "commun.personnes", sortie: { agregats: [{ fonction: "compter", alias: "n" }] } } };
    expect(() => verifierListeBlanche({ x: base })).not.toThrow();
    expect(() => verifierListeBlanche({ x: { ...base, sql: "SELECT 1" } })).toThrow();
    expect(() => verifierListeBlanche({ x: { ...base, nom: "y" } })).toThrow();
    expect(() => verifierListeBlanche({ x: { ...base, mode: "ecriture" } })).toThrow();
    expect(() => verifierListeBlanche(LISTE_BLANCHE)).not.toThrow();
  });

  it("[B-070] @isolation par défaut, l'équipe ne lit que des métadonnées", async () => {
    const { service, ouvertures } = monde();
    expect(await service.executer(equipe(), "compterPersonnes", {})).toEqual([{ total: 3 }]);
    expect(await service.executer(equipe(), "etatDonnees", {})).toHaveLength(1);
    expect(ouvertures.every((o) => o.role === "lecture")).toBe(true);
    expect(await code(service.executer(equipe(), "listerListesProspects", {}))).toBe("action_interdite");
  });

  it("[C-006] @isolation l'équipe ne voit pas le contenu de la base d'un client", async () => {
    const { service, appels } = monde();
    expect(await code(service.executer(equipe(), "listerListesProspects", {}))).toBe("action_interdite");
    const perimee = equipe({ vue: { tenantId: A, expireLe: new Date(T0.getTime() - 1) } });
    expect(await code(service.executer(perimee, "listerListesProspects", {}))).toBe("action_interdite");
    const autre = equipe({ vue: { tenantId: B, expireLe: new Date(T0.getTime() + 3_600_000) } });
    expect(await code(service.executer(autre, "listerListesProspects", {}))).toBe("action_interdite");
    expect(appels.filter((a) => a.texte.includes("listes_prospects"))).toEqual([]);
  });

  it("[A-005] pendant la vue « comme le client », l'équipe lit en lecture seule : aucun rôle app n'est ouvert, aucune écriture n'est déclarable", async () => {
    const { service, appels, ouvertures, vues } = monde();
    vues.set(`e1|${A}`, { expireLe: new Date(T0.getTime() + 60_000) });
    const vue = equipe({ vue: { tenantId: A, expireLe: new Date(T0.getTime() + 60_000) } });
    expect((await service.executer(vue, "listerListesProspects", {})).length).toBe(1);
    await service.executer(client(), "listerListesProspects", {});
    expect(ouvertures.every((o) => o.role === "lecture")).toBe(true);
    expect(appels.some((a) => a.role === "app")).toBe(false);
    expect(() => declarer({ nom: "ecrireListe", mode: "ecriture", metadonnees: false, parametres: {}, forme: { type: "simple", table: "commun.listes_prospects", sortie: { lignes: [{ colonne: "id" }] }, limite: { fixe: 1 } } })).toThrow();
  });

  it("[A-170] seules les colonnes déclarées sortent, jamais une colonne en plus", async () => {
    const { service } = monde();
    expect(Object.keys((await service.executer(client(), "listerListesProspects", {}))[0]!).sort()).toEqual(["cree_le", "id", "nom"]);
  });

  it("[A-170] un pool inactif est fermé, jamais réutilisé pour une autre base", async () => {
    let t = T0.getTime();
    const fermes: string[] = [];
    const ports: PortsDonnees = { base: async (id) => ({ nomBase: `cli_${id.slice(0, 4)}`, etat: "active" }), ouvrir: async (b) => ({ requete: async () => [], fermer: async () => void fermes.push(b) }), accordValide: async () => false, vueRangee: () => undefined, maintenant: () => new Date(t) };
    const service = creerServiceDonnees(ports);
    await service.executer(client(A), "compterPersonnes", {});
    t += 600_000;
    await service.balayer(300_000);
    expect(fermes).toEqual(["cli_1111"]);
  });

  it("[A-170] l'échec d'une ouverture ne supprime pas l'entrée plus récente de la même clé", async () => {
    let n = 0;
    const ouvertures: string[] = [];
    let echouer!: (e: Error) => void;
    const ports: PortsDonnees = {
      base: async (id) => ({ nomBase: `cli_${id.slice(0, 4)}`, etat: "active" }),
      ouvrir: (b) => {
        n += 1;
        ouvertures.push(`${b}#${n}`);
        if (n === 1) return new Promise<Connexion>((_, rej) => { echouer = rej; });
        return Promise.resolve({ requete: async () => [], fermer: async () => {} });
      },
      accordValide: async () => false,
      vueRangee: () => undefined,
      maintenant: () => T0,
    };
    const service = creerServiceDonnees(ports);
    const premier = service.executer(client(A), "compterPersonnes", {}).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    const balayage = service.balayer(-1).catch(() => undefined); // retire l'entrée 1 de la table, sans attendre sa promesse
    await service.executer(client(A), "compterPersonnes", {}); // crée l'entrée 2 pour la même clé
    echouer(new Error("panne"));
    await premier;
    await balayage;
    await new Promise((r) => setTimeout(r, 0));
    await service.executer(client(A), "compterPersonnes", {});
    expect(ouvertures).toEqual(["cli_1111#1", "cli_1111#2"]);
  });

  it("[A-229] le service des données lit une base en N et une base en N-1 et choisit la variante de la requête", async () => {
    const versions: Record<string, number> = { cli_1111: 2, cli_2222: 1 };
    const vues: string[] = [];
    const ports: PortsDonnees = {
      async base(t) { return { nomBase: t === A ? "cli_1111" : "cli_2222", etat: "active" }; },
      accordValide: async () => false,
      vueRangee: async () => undefined,
      async ouvrir(base): Promise<Connexion> {
        return {
          async requete(texte) {
            vues.push(`${base}|${texte}`);
            if (texte.includes("version_structure")) return [{ v: versions[base] }];
            return [{ n: 1 }];
          },
          async fermer() {},
        };
      },
      maintenant: () => T0,
    };
    const compte = (table: string) => ({ type: "simple", table, sortie: { agregats: [{ fonction: "compter", alias: "n" }] } });
    const requete = declarer({ nom: "deuxVariantes", mode: "lecture", metadonnees: true, parametres: {}, forme: compte("commun.personnes"), variantes: [{ depuis: 2, forme: compte("commun.listes_prospects") }] });
    const service = creerServiceDonnees(ports, { deuxVariantes: requete });
    await service.executer(client(A), "deuxVariantes", {});
    await service.executer(client(B), "deuxVariantes", {});
    expect(vues.filter((v) => v.includes("listes_prospects")).map((v) => v.split("|")[0])).toEqual(["cli_1111"]);
    expect(vues.filter((v) => v.includes("commun\".\"personnes")).map((v) => v.split("|")[0])).toEqual(["cli_2222"]);
    // Une version illisible ou absente : variante la plus ancienne, jamais la nouvelle.
    versions["cli_1111"] = Number.NaN;
    vues.length = 0;
    await service.executer(client(A), "deuxVariantes", {});
    expect(vues.some((v) => v.includes("listes_prospects"))).toBe(false);
  });
  it("[A-170] le service n'envoie que le SQL du générateur et ses deux constantes : aucun autre texte SELECT dans le code des données", () => {
    const dossier = fileURLToPath(new URL("./", import.meta.url));
    const fichiers = [`${dossier}service.ts`, ...readdirSync(`${dossier}requetes`).filter((f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "generer.ts").map((f) => `${dossier}requetes/${f}`)];
    const trouves: string[] = [];
    for (const f of fichiers) {
      const code = readFileSync(f, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
      for (const m of code.matchAll(/(["'`])((?:(?!\1)[^\n\\])*\bSELECT\b(?:(?!\1)[^\n\\])*)\1/gi)) trouves.push(m[2]!);
    }
    expect(trouves.sort()).toEqual(["SELECT coalesce(max(version), 0) AS v FROM public.version_structure", "SELECT id FROM commun.etablissements"]);
  });

  it("[B-173] la lecture des établissements de l'équipe est un texte constant : aucune entrée de la session ni de la requête n'y passe", async () => {
    const { service, appels } = monde();
    await service.executer(equipe({ acteur: "x'; DROP TABLE commun.personnes; --" }), "compterPersonnes", { tenantId: B, q: "' OR true --" });
    const lecture = appels.find((a) => a.texte.includes("commun.etablissements"))!;
    expect(lecture.texte).toBe("SELECT id FROM commun.etablissements");
    expect(lecture.valeurs).toEqual([]);
  });
});
