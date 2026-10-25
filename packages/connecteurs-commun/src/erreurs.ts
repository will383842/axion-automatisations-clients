export const CLASSES = ["passagere", "quota", "identification", "definitive"] as const;
export type Classe = (typeof CLASSES)[number];

export class ErreurConnecteur extends Error {
  constructor(
    readonly classe: Classe,
    readonly code: string,
    readonly details: { reprise?: string } = {},
  ) {
    super(code);
  }
}

// Toute erreur sortante tombe dans une des 4 classes ; l'inattendu est definitive, jamais passagere (A-406).
export function classer(e: unknown): ErreurConnecteur {
  if (!(e instanceof ErreurConnecteur) || !CLASSES.includes(e.classe)) return new ErreurConnecteur("definitive", "inattendue");
  if (e.classe === "quota" && Number.isNaN(Date.parse(e.details.reprise ?? ""))) return new ErreurConnecteur("definitive", "quota_sans_date");
  return e;
}

// Liste fermée : des identifiants et des codes, jamais de contenu.
const CHAMPS_JOURNAL = new Set(["id", "code", "classe", "action", "famille", "outil", "version"]);
const VALEUR_JOURNAL = /^[\w.:<>@-]{1,200}$/;

export function journaliser(ligne: Record<string, unknown>): string {
  for (const [cle, valeur] of Object.entries(ligne)) {
    if (!CHAMPS_JOURNAL.has(cle)) throw new Error(`champ « ${cle} » hors de la liste fermée du journal`);
    if (typeof valeur !== "string" || !VALEUR_JOURNAL.test(valeur)) throw new Error(`valeur du champ « ${cle} » refusée`);
  }
  return JSON.stringify(ligne);
}
