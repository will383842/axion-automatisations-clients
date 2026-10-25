import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { defineAutomation, type Manifeste } from "../manifeste.ts";
import { empreinte } from "./empreinte.ts";
import { verifierCode, verifierLicences, verifierProvenance, type Paquet, type Violation } from "./gardes.ts";
import { manifesteJson } from "./manifeste-json.ts";
import { sbom } from "./sbom.ts";

// Message lisible : la règle et le paquet fautif, jamais le contenu du fichier.
export class ErreurEmballage extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super(violations.map((v) => `emballage refusé : ${v.paquet ? `${v.paquet} : ` : ""}règle ${MESSAGES[v.regle]}`).join(" ; "));
    this.violations = violations;
  }
}
const MESSAGES: Record<Violation["regle"], string> = {
  licence: "licence non permise (licence)",
  provenance: "n8n ou éditeur visuel interdit (provenance)",
  nom: "nom du dossier différent du nom déclaré (nom)",
  cle: "clé en dur dans le module (clé)",
  courriel: "adresse e-mail réelle dans le module (courriel)",
  "url-identifiant": "URL avec identifiant dans le module (url-identifiant)",
  chemin: "chemin de la machine dans le module (chemin)",
};
const DEFINE = "emballage refusé : le module n'exporte pas un manifeste produit par defineAutomation";

// Un paquet emballé = un dossier node_modules/<nom> dont un fichier est dans le graphe d'esbuild.
// Indexé par le chemin réel du dossier : deux versions du même nom sont deux paquets, chacun vérifié et listé.
function paquetsEmballes(entrees: string[], violations: Violation[]): Paquet[] {
  const dossiers = new Map<string, string>();
  for (const f of entrees) {
    const morceaux = f.split(sep);
    const i = morceaux.lastIndexOf("node_modules");
    if (i < 0) continue;
    const portee = morceaux[i + 1]?.startsWith("@") ? 2 : 1;
    dossiers.set(morceaux.slice(0, i + 1 + portee).join(sep), morceaux.slice(i + 1, i + 1 + portee).join("/"));
  }
  return [...dossiers].map(([chemin, dossier]) => {
    const pkg = JSON.parse(readFileSync(join(chemin, "package.json"), "utf8")) as { name?: string; version?: string; license?: unknown };
    if (pkg.name !== dossier) violations.push({ regle: "nom", paquet: dossier });
    return { nom: dossier, version: String(pkg.version ?? "0.0.0"), licence: typeof pkg.license === "string" ? pkg.license : undefined };
  });
}

export async function construire(cheminModule: string, dossierSortie = join(dirname(resolve(cheminModule)), "artefact")): Promise<{ dossier: string; empreinte: string }> {
  const module = resolve(cheminModule);
  const racine = dirname(module);
  const r = await build({
    entryPoints: [basename(module)],
    absWorkingDir: racine,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    // Sans espaces ni commentaires : esbuild y écrit les chemins relatifs des fichiers, donc l'arborescence de la machine.
    minifyWhitespace: true,
    logLevel: "silent",
    outfile: "module.js",
  });
  const sortie = r.outputFiles[0]?.contents;
  if (r.outputFiles.length !== 1 || !sortie) throw new Error("emballage refusé : une seule sortie attendue");
  const code = Buffer.from(sortie);

  const violations: Violation[] = [];
  const paquets = paquetsEmballes(Object.keys(r.metafile.inputs).map((f) => resolve(racine, f)), violations);
  violations.push(...verifierLicences(paquets), ...verifierProvenance(paquets), ...verifierCode(code.toString("utf8"), [racine, tmpdir(), homedir(), process.cwd()]));
  if (violations.length) throw new ErreurEmballage(violations);

  // Le module doit exporter un manifeste qui repasse defineAutomation (A-283).
  const charge = (await import(`${pathToFileURL(module).href}?emballage`)) as Record<string, unknown>;
  const exporte = Object.values(charge).find((v): v is Record<string, unknown> => typeof v === "object" && v !== null && "schemaReglages" in v && "paquet" in v);
  if (!exporte) throw new Error(DEFINE);
  const source = Object.fromEntries(Object.entries(exporte).filter(([k]) => !["paquet", "schemaReglages", "instancier", "classerAction"].includes(k)));
  try {
    defineAutomation(source as unknown as Manifeste);
  } catch {
    throw new Error(DEFINE);
  }

  const manifest = Buffer.from(manifesteJson(exporte));
  const sbomOctets = Buffer.from(`${JSON.stringify(sbom(String(exporte.code), String(exporte.version), paquets), null, 2)}\n`);
  const hash = empreinte(code, manifest, sbomOctets);

  await mkdir(dossierSortie, { recursive: true });
  const fichiers: [string, Uint8Array | string][] = [["module.js", code], ["manifest.json", manifest], ["sbom.cdx.json", sbomOctets], ["empreinte.sha256", `${hash}\n`]];
  for (const [nom, contenu] of fichiers) {
    // rm retire un lien symbolique lui-même : l'écriture ne passe jamais à travers.
    await rm(join(dossierSortie, nom), { force: true });
    await writeFile(join(dossierSortie, nom), contenu, { flag: "wx" });
  }
  return { dossier: dossierSortie, empreinte: hash };
}
