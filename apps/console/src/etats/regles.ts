import { messages } from "@axion-auto/design/src/textes/messages.fr.ts";

// Règles d'or qu'une machine sait vérifier (T3-04), sur le HTML rendu d'un écran. Limite assumée : ce sont des motifs sur du texte,
// non exhaustifs par nature ; axe-core et les quatre formats d'écran relèvent du banc Playwright.

const ENTITES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };

/** Texte lu par la personne : balises retirées, entités décodées. */
export function texteVisible(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (m) => ENTITES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

const compter = (html: string, motif: RegExp) => (html.match(motif) ?? []).length;

/** Boutons principaux de l'écran (B-201, B-290) : au plus un. */
export const boutonsPrincipaux = (html: string): number => compter(html, /data-variante="principal"/g);

/** État vide : une phrase et un bouton (B-204, B-301). */
export const etatVideValide = (html: string): boolean =>
  compter(html, /<p[\s>]/g) === 1 && compter(html, /<(?:button|a)[\s>]/g) === 1 && texteVisible(html.match(/<p[\s>][\s\S]*?<\/p>/)?.[0] ?? "") !== "";

/** Chargement : l'indicateur est dans le premier rendu, avec un mot (B-208, B-302). */
export function etatChargementValide(html: string): boolean {
  const m = /<([a-z0-9]+)[^>]*role="status"[^>]*>([\s\S]*?)<\/\1>/.exec(html);
  return m !== null && texteVisible(m[2] ?? "") !== "";
}

function attributs(balise: string): Record<string, string> {
  return Object.fromEntries([...balise.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], texteVisible(a[2] ?? "")]));
}

/** Erreur : message du catalogue (T0-23) et saisie conservée (B-207, B-303, B-311). */
export function etatErreurValide(html: string, saisies: Record<string, string>): boolean {
  const texte = texteVisible(html);
  const catalogue = Object.values(messages).some((m) => texte.includes(m.titre) && texte.includes(m.phrase));
  const champs = (html.match(/<(?:input|textarea)[^>]*>/g) ?? []).map(attributs);
  return catalogue && Object.entries(saisies).every(([nom, valeur]) => champs.some((c) => c["name"] === nom && c["value"] === valeur));
}

/** Pastilles sans mot (B-205, B-223, B-268). */
export const pastillesSansMot = (html: string): number =>
  [...html.matchAll(/<([a-z0-9]+)[^>]*data-couleur="[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)].filter((m) => texteVisible(m[2] ?? "") === "").length;

/** Mots du lexique interdit (B-226), en mots entiers, sans tenir compte de la casse. */
export function motsInterdits(html: string, lexique: readonly string[]): string[] {
  const texte = texteVisible(html).toLowerCase();
  return lexique.filter((mot) => new RegExp(`(?<![\\p{L}\\p{N}])${mot.toLowerCase()}(?![\\p{L}\\p{N}])`, "u").test(texte));
}

/** Tutoiement (B-309) : pronoms et possessifs de la deuxième personne du singulier. */
export const tutoiement = (texte: string): string[] => texte.match(/(?<![\p{L}'’-])(?:tu|toi|ton|ta|tes|t['’])(?![\p{L}])/giu) ?? [];

/** Contrôles structurels (C-594) : un titre h1, images avec alt, boutons nommés, champs étiquetés. */
export function controlesStructurels(html: string): string[] {
  const fautes: string[] = [];
  if (compter(html, /<h1[\s>]/g) !== 1) fautes.push("un titre h1 attendu");
  if ((html.match(/<img[^>]*>/g) ?? []).some((i) => !/\salt=/.test(i))) fautes.push("image sans alt");
  const boutons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
  if (boutons.some((b) => texteVisible(b[2] ?? "") === "" && !/aria-label="[^"]+"/.test(b[1] ?? ""))) fautes.push("bouton sans nom");
  const champs = (html.match(/<(?:input|select|textarea)[^>]*>/g) ?? []).filter((c) => !/type="hidden"/.test(c));
  const etiquettes = [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]);
  if (champs.some((c) => !/aria-label="[^"]+"/.test(c) && !etiquettes.includes(attributs(c)["id"] ?? "\0"))) fautes.push("champ sans libellé");
  return fautes;
}
