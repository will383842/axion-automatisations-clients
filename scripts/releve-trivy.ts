import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Relevé et évaluation d'un rapport Trivy (images dérivées, ADR 0014). Mêmes seuils que la garde des briques : critique corrigeable 7 jours, haute 30 jours.
// Aucune option d'ignorance. Ne sort que des numéros d'avis publics, des noms de paquets et des chemins de fichiers.

const JOUR = 86_400_000;
const DELAIS_JOURS: Record<string, number> = { CRITICAL: 7, HIGH: 30 };
type Obj = Record<string, unknown>;
const estObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function avis(rapport: unknown): Obj[] {
  const resultats = estObj(rapport) && Array.isArray(rapport.Results) ? rapport.Results : [];
  return resultats.flatMap((r) => (estObj(r) && Array.isArray(r.Vulnerabilities) ? r.Vulnerabilities.filter(estObj) : []));
}

// Une ligne par avis : « identifiant gravité paquet installée → corrigée (chemin) ».
export function relever(rapport: unknown): string[] {
  const lignes = avis(rapport).map((v) => `${String(v.VulnerabilityID)} ${String(v.Severity)} ${String(v.PkgName)} ${String(v.InstalledVersion)} → ${v.FixedVersion ? String(v.FixedVersion) : "aucune"} (${String(v.PkgPath ?? v.PkgName)})`);
  return [...new Set(lignes)];
}

export function evaluer(rapport: unknown, image: string, maintenant: Date): string[] {
  if (!estObj(rapport) || !Array.isArray(rapport.Results)) return [`rapport Trivy invalide pour ${image}`];
  const sorties = new Set<string>();
  for (const v of avis(rapport)) {
    const delai = DELAIS_JOURS[String(v.Severity)];
    if (delai === undefined || !v.FixedVersion) continue;
    const publie = Date.parse(String(v.PublishedDate));
    if (Number.isNaN(publie) || (maintenant.getTime() - publie) / JOUR > delai) sorties.add(`${String(v.VulnerabilityID ?? "avis-inconnu")} ${image}`);
  }
  return [...sorties];
}

// Usage : node scripts/releve-trivy.ts --releve <rapport.json> | --garde <rapport.json> <image>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, fichier, image] = process.argv.slice(2);
  let rapport: unknown;
  try {
    rapport = JSON.parse(readFileSync(fichier ?? "", "utf8"));
  } catch {
    console.error(`rapport Trivy illisible : ${image ?? ""}`);
    process.exit(1);
  }
  if (mode === "--releve") {
    for (const l of relever(rapport)) console.log(l);
  } else if (mode === "--garde") {
    const erreurs = evaluer(rapport, image ?? "image-inconnue", new Date());
    for (const e of erreurs) console.error(e);
    process.exit(erreurs.length ? 1 : 0);
  } else {
    console.error("usage : --releve <rapport> | --garde <rapport> <image>");
    process.exit(2);
  }
}
