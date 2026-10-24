import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Audit des dépendances (plan section 4) : critique sous 7 jours, haute sous 30 jours, depuis la date de publication de l'avis.
// Lit la sortie de « pnpm audit --json ». N'affiche que l'identifiant de l'avis et le paquet.

const DELAIS_JOURS: Record<string, number> = { critical: 7, high: 30 };
const JOUR = 86_400_000;

interface Avis {
  github_advisory_id?: string;
  id?: number | string;
  module_name?: string;
  severity?: string;
  published?: string;
  created?: string;
}

export interface Verdict {
  echecs: string[];
  avertissements: string[];
}

export function evaluerAudit(rapport: { advisories?: Record<string, Avis> }, maintenant: Date): Verdict {
  const verdict: Verdict = { echecs: [], avertissements: [] };
  for (const avis of Object.values(rapport.advisories ?? {})) {
    const delai = DELAIS_JOURS[avis.severity ?? ""];
    if (delai === undefined) continue;
    const libelle = `${avis.github_advisory_id ?? avis.id ?? "avis-inconnu"} ${avis.module_name ?? "paquet-inconnu"}`;
    const publie = Date.parse(avis.published ?? avis.created ?? "");
    // Date illisible : on échoue, jamais de passage par défaut.
    if (Number.isNaN(publie) || (maintenant.getTime() - publie) / JOUR > delai) verdict.echecs.push(libelle);
    else verdict.avertissements.push(libelle);
  }
  return verdict;
}

// Usage : node scripts/audit-dependances.ts <audit.json>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let rapport: { advisories?: Record<string, Avis> };
  try {
    rapport = JSON.parse(readFileSync(process.argv[2] ?? "audit.json", "utf8"));
  } catch {
    console.error("Rapport d'audit illisible : échec.");
    process.exit(1);
  }
  const v = evaluerAudit(rapport, new Date());
  for (const a of v.avertissements) console.warn(`AVERTISSEMENT ${a} (dans le délai)`);
  for (const e of v.echecs) console.error(`ÉCHEC ${e} (délai dépassé)`);
  process.exit(v.echecs.length ? 1 : 0);
}
