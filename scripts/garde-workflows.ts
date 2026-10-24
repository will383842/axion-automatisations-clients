import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Garde des workflows (C-528, C-529). Lecture ligne à ligne : aucune dépendance, aucun code exécuté.

const SHA = /^[0-9a-f]{40}$/;
const DECLENCHEURS_RESERVES = new Set(["push", "schedule", "workflow_dispatch"]);

const sansCommentaire = (ligne: string) => ligne.replace(/(^|\s)#.*$/, "");

function declencheurs(lignes: string[]): string[] {
  const i = lignes.findIndex((l) => /^["']?on["']?:/.test(l));
  if (i < 0) return [];
  const reste = (lignes[i] ?? "").replace(/^["']?on["']?:/, "").trim();
  if (reste) return reste.split(/[[\],\s]+/).filter(Boolean);
  const noms: string[] = [];
  let indent = -1;
  for (const l of lignes.slice(i + 1)) {
    if (!l.trim()) continue;
    const marge = l.length - l.trimStart().length;
    if (marge === 0) break;
    if (indent < 0) indent = marge;
    if (marge !== indent) continue;
    const m = /^\s*(?:-\s*)?([a-z_]+)\s*:?/.exec(l);
    if (m?.[1]) noms.push(m[1]);
  }
  return noms;
}

export function verifierWorkflow(nom: string, texte: string): string[] {
  const lignes = texte.split("\n").map(sansCommentaire);
  const erreurs: string[] = [];
  const echec = (n: number, msg: string) => erreurs.push(`${nom}:${n}: ${msg}`);
  const trigs = declencheurs(lignes);
  const surPr = trigs.includes("pull_request");

  if (trigs.includes("pull_request_target")) echec(1, "pull_request_target est interdit");
  if (!lignes.some((l) => /^permissions:/.test(l))) echec(1, "bloc permissions absent en tête du fichier");

  lignes.forEach((l, idx) => {
    const n = idx + 1;
    if (/^\s*runs-on:.*self-hosted/.test(l) || (/self-hosted/.test(l) && /runs-on/.test(lignes[idx - 1] ?? ""))) {
      echec(n, "runs-on self-hosted est interdit");
    }
    if (/^\s*permissions:\s*write-all/.test(l)) echec(n, "permissions: write-all est interdit");
    if (surPr) {
      for (const m of l.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
        if (m[1] !== "GITHUB_TOKEN") echec(n, `secrets.${m[1]} interdit dans un workflow pull_request`);
      }
      if (/^\s*secrets:\s*inherit/.test(l)) echec(n, "secrets: inherit interdit dans un workflow pull_request");
    }
    const u = /^\s*(?:-\s*)?uses:\s*["']?([^\s"']+)/.exec(l);
    if (u?.[1] && !u[1].startsWith("./")) {
      const ref = u[1].split("@")[1] ?? "";
      if (!SHA.test(ref)) echec(n, `action non épinglée par SHA : ${u[1]}`);
    }
    if (/^\s*environment:/.test(l)) {
      const hors = trigs.filter((t) => !DECLENCHEURS_RESERVES.has(t));
      const pushHorsMain = trigs.includes("push") && !lignes.some((x) => /branches:.*\bmain\b/.test(x));
      if (hors.length > 0 || pushHorsMain) {
        echec(n, "environment réservé aux workflows de main et planifiés");
      }
    }
  });
  return erreurs;
}

export function verifierDossier(dossier: string): string[] {
  return readdirSync(dossier)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => verifierWorkflow(f, readFileSync(join(dossier, f), "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = verifierDossier(process.argv[2] ?? ".github/workflows");
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
