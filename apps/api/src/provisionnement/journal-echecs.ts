import { writeSync } from "node:fs";
import { afterAll, afterEach } from "vitest";

// Journal des échecs des essais d'intégration (CI) : le rapport JSON n'est pas publié et Vitest capture console.log.
// Tout passe donc par writeSync(2, …), comme tests/audit-1a : le journal du job montre l'ECHEC, l'erreur hors test et le BILAN.
// Jamais de valeur secrète : adresses de connexion masquées, première ligne du message seulement, 400 caractères au plus.
export const premiereLigne = (message: unknown, max = 400): string =>
  String(message ?? "").split("\n")[0]!.replace(/:\/\/[^@\s]*@/g, "://***@").slice(0, max);

export const ecrireEchec = (fichier: string, nom: string, message: unknown, max = 400): void => {
  writeSync(2, `ECHEC ${fichier} ${nom} :: ${premiereLigne(message, max)}\n`);
};

// À appeler une fois, en haut d'un fichier .int.test.ts : journalEchecs(import.meta.url).
export function journalEchecs(url: string): void {
  const fichier = url.split("/").pop() ?? "";
  const bilan = { verts: 0, rouges: 0 };
  const nonGerees: string[] = [];
  for (const evenement of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(evenement, (e: unknown) => {
      const err = e instanceof Error ? e : new Error(typeof e);
      nonGerees.push(`${evenement} ${err.name}`);
      // Nom et code seulement : le message peut contenir une adresse ou une valeur.
      writeSync(2, `ERREUR NON GEREE ${fichier} (${evenement}) : ${err.name} ${(err as { code?: string }).code ?? ""}\n`);
    });
  }
  afterEach((ctx) => {
    const r = ctx.task.result;
    if (r?.state === "fail") {
      bilan.rouges++;
      ecrireEchec(fichier, ctx.task.name, r.errors?.[0]?.message);
    } else if (r?.state === "pass") bilan.verts++;
  });
  afterAll(() => {
    writeSync(2, `BILAN ${fichier} : ${bilan.verts} verts, ${bilan.rouges} rouges\n`);
    // Écouter l'événement retire à Vitest son propre constat : le fichier échoue ici.
    if (nonGerees.length > 0) throw new Error(`erreurs hors test : ${nonGerees.join(", ")}`);
  });
}
