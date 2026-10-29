// Source unique des jetons de design (C-586, C-595, C-597). Tout le code les utilise ; jetons.css en est généré.
// Valeurs : guide de style final (« couleur maîtrisée ») et style « blocs colorés ». Aucun bleu (C-597).

export const jetons = {
  couleur: {
    menu: { fond: "#9a3812", texte: "#ffffff", secondaire: "#ffe9df", separateur: "rgba(255,255,255,0.25)", actif: { fond: "#ffffff", texte: "#7a2c0d" } },
    fond: { portail: "#f6efe6", console: "#f3ece2", carte: "#ffffff" },
    bordure: { carte: "#ead9c6", secondaire: "#857a69", champ: "#7a6f5f" },
    separateur: "#e3d9c6",
    texte: { principal: "#14120f", secondaire: "#3a332b", discret: "#5e5548" },
    action: "#c24a1b",
    actionTexte: "#9e3a12",
    lien: "#a83e15",
    initiales: { fond: "#2a2520", texte: "#ffffff" },
    peche: { fond: "#fbe3d6", titre: "#7a2c0d" },
    sauge: { fond: "#e4f0e8", titre: "#1f5a3e", texte: "#24412f" },
    miel: { fond: "#f7ebcc", titre: "#5a4106", texte: "#4a3a12" },
    rose: { fond: "#f9e1e4", titre: "#7a2236" },
    // Teintes des blocs colorés : une teinte = un sens. La teinte « bleu » (chiffres clés) n'est PAS reprise : C-597.
    teinte: {
      terracotta: { fond: "#fbe3d6", bordure: "#efc3ae", liseret: "#b13a2b", titre: "#7a2c0d" },
      vert: { fond: "#dfeee4", bordure: "#b5d5c1", liseret: "#1f6b4a", titre: "#1f5a3e" },
      ambre: { fond: "#f8eac8", bordure: "#e3cd94", liseret: "#8a5a0b", titre: "#5a4106" },
      violet: { fond: "#ebe4f5", bordure: "#cfc2e6", liseret: "#6a4c9c", titre: "#3d2766" },
      gris: { fond: "#ede8e1", bordure: "#d4c9bb", liseret: "#5e5548", titre: "#2f2a24" },
    },
    automatisation: {
      tri: { tuile: "#c24a1b", carte: "#fdf3ee", bordure: "#f2d3c3" },
      comptesRendus: { tuile: "#1f6b4a", carte: "#eef6f1", bordure: "#cfe5d8" },
      relances: { tuile: "#8a5a0b", carte: "#fbf3e0", bordure: "#eedcae" },
    },
    etat: {
      urgent: { fond: "#f6dcd6", texte: "#6a1c10", trait: "#b13a2b" },
      averifier: { fond: "#f7e7c4", texte: "#5a3a06", trait: "#a8651b" },
      fait: { fond: "#e3efdc", texte: "#1a4720", trait: "#2f7d3a" },
      pause: { fond: "#e3d9c6", texte: "#3a332b" },
    },
    // Réservés au composant d'illustration du bandeau d'accueil (couleurs relevées dans la maquette F-Portail-Accueil).
    illustration: { soleil: "#f6c3a8", colline: "#a9cfbb", feuille: "#7fb59a", feuilleClaire: "#9cc8b0", brume: "#cfe5d8" },
  },
  rayon: { 8: "8px", 12: "12px", 14: "14px", 16: "16px", 22: "22px", 28: "28px", 999: "999px" },
  espacement: { 4: "4px", 8: "8px", 12: "12px", 16: "16px", 24: "24px", 28: "28px", 32: "32px", 48: "48px" },
  ombre: {
    carte: "0 2px 4px rgba(122,44,13,0.06), 0 12px 32px rgba(122,44,13,0.08)",
    action: "0 6px 16px rgba(194,74,27,0.28)",
    menu: "0 1px 3px rgba(40,12,2,0.35)",
  },
  police: {
    titre: '"Fraunces", Georgia, serif',
    texte: '"Manrope", system-ui, sans-serif',
    code: '"Inconsolata", ui-monospace, monospace',
  },
  taille: { texte: "15px", texteMobile: "16px", precision: "13px", soustitre: "18px", titreCarte: "24px", titrePage: "40px", titreMobile: "30px" },
} as const;

type Arbre = { readonly [cle: string]: string | Arbre };

/** Aplatit l'arbre en [chemin, valeur] : « couleur.menu.fond » -> « #9a3812 ». */
export function aplatir(arbre: Arbre = jetons, prefixe = ""): [string, string][] {
  return Object.entries(arbre).flatMap(([cle, v]) => {
    const chemin = prefixe ? `${prefixe}.${cle}` : cle;
    return typeof v === "string" ? [[chemin, v] as [string, string]] : aplatir(v, chemin);
  });
}

export function valeur(chemin: string): string {
  const v = aplatir().find(([c]) => c === chemin)?.[1];
  if (v === undefined) throw new Error(`jeton inconnu : ${chemin}`);
  return v;
}

/** Couples texte/fond déclarés : chacun doit atteindre 4,5:1 (WCAG). */
export const couplesContraste: ReadonlyArray<readonly [string, string]> = [
  ["couleur.texte.principal", "couleur.fond.portail"],
  ["couleur.texte.secondaire", "couleur.fond.portail"],
  ["couleur.texte.principal", "couleur.fond.console"],
  ["couleur.texte.secondaire", "couleur.fond.console"],
  ["couleur.texte.principal", "couleur.fond.carte"],
  ["couleur.texte.secondaire", "couleur.fond.carte"],
  ["couleur.menu.texte", "couleur.menu.fond"],
  ["couleur.menu.secondaire", "couleur.menu.fond"],
  ["couleur.menu.actif.texte", "couleur.menu.actif.fond"],
  ["couleur.lien", "couleur.fond.carte"],
  ["couleur.lien", "couleur.fond.portail"],
  ["couleur.lien", "couleur.fond.console"],
  ["couleur.lien", "couleur.peche.fond"],
  ["couleur.menu.texte", "couleur.action"],
  ["couleur.actionTexte", "couleur.peche.fond"],
  ["couleur.initiales.texte", "couleur.initiales.fond"],
  ["couleur.peche.titre", "couleur.peche.fond"],
  ["couleur.sauge.titre", "couleur.sauge.fond"],
  ["couleur.sauge.texte", "couleur.sauge.fond"],
  ["couleur.miel.titre", "couleur.miel.fond"],
  ["couleur.miel.texte", "couleur.miel.fond"],
  ["couleur.rose.titre", "couleur.rose.fond"],
  ["couleur.etat.urgent.texte", "couleur.etat.urgent.fond"],
  ["couleur.etat.averifier.texte", "couleur.etat.averifier.fond"],
  ["couleur.etat.fait.texte", "couleur.etat.fait.fond"],
  ["couleur.etat.pause.texte", "couleur.etat.pause.fond"],
  ...(["terracotta", "vert", "ambre", "violet", "gris"] as const).flatMap((t) => [
    [`couleur.teinte.${t}.titre`, `couleur.teinte.${t}.fond`],
    ["couleur.texte.principal", `couleur.teinte.${t}.fond`],
    ["couleur.texte.secondaire", `couleur.teinte.${t}.fond`],
  ] as const),
];

// --- Calculs de couleur (WCAG 2.x, teinte) ---

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const RGBA = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;
const HSLA = /hsla?\(\s*[\d.]+(?:deg)?\s*[, ]\s*[\d.]+%\s*[, ]\s*[\d.]+%\s*(?:[,/]\s*[\d.]+%?\s*)?\)/g;

/** Les couleurs littérales (hex à 3, 4, 6 ou 8 chiffres, rgb/rgba, hsl/hsla) d'un texte. */
export function couleursDe(texte: string): string[] {
  return [...(texte.match(HEX) ?? []), ...(texte.match(RGBA) ?? []), ...(texte.match(HSLA) ?? [])];
}

function rvb(couleur: string): [number, number, number] {
  if (couleur.startsWith("#")) {
    let h = couleur.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const nombres = (couleur.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (couleur.startsWith("hsl")) {
    const [t = 0, sat = 0, lum = 0] = nombres;
    const s = sat / 100;
    const l = lum / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + t / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  const [r = 0, v = 0, b = 0] = nombres;
  return [r, v, b];
}

/** Bleu : teinte entre 190° et 260° avec une saturation (HSL) supérieure à 15 %. */
export function estBleu(couleur: string): boolean {
  const [r, g, b] = rvb(couleur).map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return false;
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d + 6) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return h >= 190 && h <= 260 && s > 0.15;
}

/** Teinte (HSL, en degrés) d'une couleur ; 0 pour un gris. */
export function teinte(couleur: string): number {
  const [r, g, b] = rvb(couleur).map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  return max === r ? 60 * (((g - b) / d + 6) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
}

function luminance(couleur: string): number {
  const [r, g, b] = rvb(couleur).map((x) => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contraste(a: string, b: string): number {
  const [haut, bas] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (haut + 0.05) / (bas + 0.05);
}
