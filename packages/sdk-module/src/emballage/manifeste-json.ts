// Sérialisation stable : clés triées, fonctions et jeu d'essai retirés (les adresses d'essai ne sont pas emballées).
const RETIRES = new Set(["reglages", "jeuEssai", "paquet", "instancier", "classerAction", "migrer"]);

function trier(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trier);
  if (typeof v !== "object" || v === null) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => typeof x !== "function")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => [k, trier(x)]),
  );
}

export function manifesteJson(module: Record<string, unknown>): string {
  const gardees = Object.fromEntries(Object.entries(module).filter(([k]) => !RETIRES.has(k)));
  return `${JSON.stringify(trier(gardees), null, 2)}\n`;
}
