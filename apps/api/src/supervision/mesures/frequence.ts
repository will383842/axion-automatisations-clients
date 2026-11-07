// Fréquence attendue d'une instance (B-383), tirée de son déclencheur : cron à 5 champs ou sondage à intervalle fixe.
export type Declencheur = { type: "cron"; expression: string } | { type: "sondage"; intervalleSecondes: number };

const BORNES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MINUTE_MS = 60_000;
const HORIZON_MIN = 8 * 24 * 60; // une semaine plus un jour : couvre les crons hebdomadaires

function champ(texte: string, [min, max]: [number, number]): Set<number> | null {
  const valeurs = new Set<number>();
  for (const morceau of texte.split(",")) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(morceau);
    if (!m) return null;
    const pas = m[2] ? Number(m[2]) : 1;
    if (pas < 1) return null;
    const [d, f] = m[1] === "*" ? [min, max] : m[1]!.split("-").map(Number);
    const debut = d!;
    const fin = f ?? (m[2] ? max : debut);
    if (debut < min || fin > max || debut > fin) return null;
    for (let v = debut; v <= fin; v += pas) valeurs.add(v);
  }
  return valeurs;
}

function analyser(expression: string): Set<number>[] | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const champs = parts.map((p, i) => champ(p, BORNES[i]!));
  return champs.every((c) => c !== null) ? (champs as Set<number>[]) : null;
}

// Prochaine occurrence strictement après `apres` (UTC), ou null si le déclencheur est illisible ou sans occurrence proche.
export function prochaineAttendue(d: Declencheur | null, apres: Date): Date | null {
  if (!d) return null;
  if (d.type === "sondage") return d.intervalleSecondes > 0 ? new Date(apres.getTime() + d.intervalleSecondes * 1000) : null;
  const c = analyser(d.expression);
  if (!c) return null;
  const debut = Math.floor(apres.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let i = 1; i <= HORIZON_MIN; i++) {
    const t = new Date(debut + i * MINUTE_MS);
    if (c[0]!.has(t.getUTCMinutes()) && c[1]!.has(t.getUTCHours()) && c[2]!.has(t.getUTCDate()) && c[3]!.has(t.getUTCMonth() + 1) && c[4]!.has(t.getUTCDay())) return t;
  }
  return null;
}

// Écart entre deux occurrences successives à partir de `depuis`.
export function frequenceMs(d: Declencheur | null, depuis: Date): number | null {
  if (!d) return null;
  if (d.type === "sondage") return d.intervalleSecondes > 0 ? d.intervalleSecondes * 1000 : null;
  const a = prochaineAttendue(d, depuis);
  const b = a && prochaineAttendue(d, a);
  return a && b ? b.getTime() - a.getTime() : null;
}

// « En retard » = plus de 2 fois la fréquence depuis la dernière réussite (utilisé par T5-03). Sans déclencheur lisible : jamais en retard.
export function estEnRetard(d: Declencheur | null, derniereReussite: Date, maintenant: Date): boolean {
  const f = frequenceMs(d, derniereReussite);
  return f !== null && maintenant.getTime() - derniereReussite.getTime() > 2 * f;
}
