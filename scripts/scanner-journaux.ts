import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Scanner de journaux (C-531). Les fichiers sont lus comme du TEXTE ; la sortie ne contient jamais la valeur trouvée.

// À reconfirmer par le chef d'orchestre avant la fusion : plages ARCEP réservées à la fiction (national, sans le 0 final de 4 chiffres).
export const PLAGES_TELEPHONE_FICTION = ["0199 00", "0261 91", "0353 01", "0465 71", "0536 49", "0639 98"].map((p) => p.replace(" ", ""));
const DOMAINES_PERMIS = ["exemple.fr", "exemple.com"];
const IP_PERMISES = ["127.0.0.1", "0.0.0.0"];
const BLOCS_DOCUMENTATION = ["192.0.2.", "198.51.100.", "203.0.113."];

export type Trouvaille = { type: "e-mail" | "IBAN" | "téléphone" | "IPv4"; fichier: string; ligne: number };

const COURRIEL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
const TELEPHONE = /(?<![\d+])(?:(?:\+|00)33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}(?!\d)/g;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;

function ibanValide(brut: string): boolean {
  const s = brut.replace(/\s/g, "");
  if (s.length < 15 || s.length > 34) return false;
  const chiffres = [...(s.slice(4) + s.slice(0, 4))].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join("");
  let reste = 0;
  for (const c of chiffres) reste = (reste * 10 + Number(c)) % 97;
  return reste === 1;
}

function nationalTel(brut: string): string {
  const n = brut.replace(/\D/g, "");
  return n.startsWith("33") ? "0" + n.slice(2) : n.startsWith("0033") ? "0" + n.slice(4) : n;
}

export function scannerTexte(fichier: string, texte: string): Trouvaille[] {
  const res: Trouvaille[] = [];
  texte.split("\n").forEach((l, i) => {
    const ligne = i + 1;
    const ajouter = (type: Trouvaille["type"]) => res.push({ type, fichier, ligne });
    for (const m of l.matchAll(COURRIEL)) {
      const d = (m[1] ?? "").toLowerCase();
      if (!DOMAINES_PERMIS.includes(d) && !d.endsWith(".test")) ajouter("e-mail");
    }
    for (const m of l.matchAll(IBAN)) if (ibanValide(m[0])) ajouter("IBAN");
    for (const m of l.matchAll(TELEPHONE)) {
      const n = nationalTel(m[0]);
      if (!PLAGES_TELEPHONE_FICTION.some((p) => n.startsWith(p))) ajouter("téléphone");
    }
    for (const m of l.matchAll(IPV4)) {
      const ip = m[0];
      const valide = ip.split(".").every((o) => Number(o) <= 255);
      if (valide && !IP_PERMISES.includes(ip) && !BLOCS_DOCUMENTATION.some((b) => ip.startsWith(b))) ajouter("IPv4");
    }
  });
  return res;
}

export function formaterTrouvailles(t: Trouvaille[]): string[] {
  return t.map((x) => `${x.type}, ${x.fichier}, ligne ${x.ligne}`);
}

function fichiersDe(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? fichiersDe(chemin) : [chemin];
  });
}

// Usage : node scripts/scanner-journaux.ts <dossier des journaux>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dossier = process.argv[2] ?? ".";
  const trouvailles = fichiersDe(dossier).flatMap((f) => scannerTexte(f.slice(dossier.length + 1), readFileSync(f, "latin1")));
  for (const l of formaterTrouvailles(trouvailles)) console.error(l);
  process.exit(trouvailles.length ? 1 : 0);
}
