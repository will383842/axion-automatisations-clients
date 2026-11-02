import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOSSIERS_GARDES, EXCEPTIONS, verifierGel } from "./garde-gel.ts";

const f = (chemin: string, contenu: string) => ({ chemin, contenu });
const fichiers = (dossier: string): string[] =>
  statSync(dossier, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(dossier).flatMap((n) => (statSync(join(dossier, n)).isDirectory() ? fichiers(join(dossier, n)) : [join(dossier, n)]))
    : [];

describe("garde du gel pour litige", () => {
  it("[C-609] la garde de CI trouve un chemin de suppression sans vérification du gel", () => {
    for (const appel of ["DROP TABLE x", "s3.deleteObject(p)", "client.send(new DeleteObjectsCommand(p))", "await detruireCleClient(id)", "partman.drop_partition_time(n)", "await depot.retirerPartition(n)",
      "client.send(new DeleteObjectCommand(p))", "s3.deleteObjects(p)", "drop table x", "delete from t where a = 1", "TRUNCATE t", "rmSync(d)", "unlink(f)", "await rm(f)"]) {
      const sans = verifierGel([f("apps/api/src/retention/x.ts", appel)]);
      expect(sans.join("\n"), appel).toMatch(/retention\/x\.ts.*gel/);
    }
    for (const dossier of DOSSIERS_GARDES) expect(verifierGel([f(`apps/api/src/${dossier}/y.ts`, "deleteObject(x)")])).toHaveLength(1);
  });

  it("[C-609] un commentaire ne vaut pas vérification, un commentaire de suppression ne déclenche rien", () => {
    expect(verifierGel([f("apps/api/src/retention/c.ts", "// gelActif à brancher\n/* exigerAucunGel */ deleteObject(k)")])).toHaveLength(1);
    expect(verifierGel([f("apps/api/src/retention/c.ts", "// on ne fait pas de DROP ici\nconst x = 1;")])).toEqual([]);
  });

  it("[C-609] detruireCleClient est gardé dans tout apps/api/src, sauf sa définition nommée", () => {
    expect(verifierGel([f("apps/api/src/autre/z.ts", "await coffre.detruireCleClient(t, c)")])).toHaveLength(1);
    expect(verifierGel([f("apps/api/src/autre/z.ts", "await exigerAucunGel(g, t, 'effacement'); await coffre.detruireCleClient(t, c)")])).toEqual([]);
    expect(verifierGel([f("apps/api/src/coffre/enveloppe.ts", "async detruireCleClient() {}")])).toEqual([]);
    expect(EXCEPTIONS.map((e) => e.chemin)).toEqual(["apps/api/src/coffre/enveloppe.ts"]);
  });

  it("[C-609] tout fichier de fin-de-contrat qui exporte une fonction, ou parle de REVOKE, a_l_ecart ou desactive, vérifie le gel", () => {
    for (const c of ["export async function finir() {}", "export const finir = async () => {}", "await sql`REVOKE ALL ON x`", "mettre('a_l_ecart')", "desactive(c)"]) {
      expect(verifierGel([f("apps/api/src/fin-de-contrat/k.ts", c)]), c).toHaveLength(1);
    }
    expect(verifierGel([f("apps/api/src/fin-de-contrat/k.ts", "export async function finir() { await retirerSousGel(tx, lire, t, 'effacement', r) }")])).toEqual([]);
    expect(verifierGel([f("apps/api/src/fin-de-contrat/k.test.ts", "export function x() {}")])).toEqual([]);
  });

  it("[C-609] un fichier qui appelle exigerAucunGel ou gelActif passe ; un dossier hors liste et un test ne sont pas gardés", () => {
    expect(verifierGel([f("apps/api/src/export/a.ts", "await exigerAucunGel(g, t, 'x'); deleteObject(k)")])).toEqual([]);
    expect(verifierGel([f("apps/api/src/sauvegardes/a.ts", "if (await gel.gelActif(t)) return; DeleteObjects(k)")])).toEqual([]);
    expect(verifierGel([f("apps/api/src/fin-de-contrat/a.ts", "deleteObject(k)")])).toHaveLength(1);
    expect(verifierGel([f("apps/api/src/autre/a.ts", "deleteObject(k)"), f("apps/api/src/retention/a.test.ts", "deleteObject(k)")])).toEqual([]);
  });

  it("[C-609] la liste d'exceptions est fermée, chaque exception a une raison et un fichier, et le garde la respecte", () => {
    for (const e of EXCEPTIONS) {
      expect(e.raison.trim().length, e.chemin).toBeGreaterThan(10);
      expect(statSync(e.chemin, { throwIfNoEntry: false })?.isFile(), e.chemin).toBe(true);
    }
    for (const e of EXCEPTIONS) expect(verifierGel([f(e.chemin, "detruireCleClient(k)")])).toEqual([]);
  });

  it("[C-609] tous les chemins de retrait du dépôt (rétention, sauvegardes, export, fin de contrat, et detruireCleClient partout) vérifient le gel", () => {
    const racine = new URL("..", import.meta.url).pathname;
    const reels = fichiers(join(racine, "apps/api/src")).map((p) => f(p.slice(racine.length), readFileSync(p, "utf8")));
    expect(reels.some((x) => x.chemin.includes("retention/purger.ts"))).toBe(true);
    expect(verifierGel(reels)).toEqual([]);
  });
});
