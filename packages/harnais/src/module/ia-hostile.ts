import type { PasserelleIa } from "@axion-auto/sdk-module";

// Le fil de l'essai : seules ces adresses et cet identifiant sont permis. Tout le reste est interdit.
export const FIL = { id: "fil-1", adresses: ["client@exemple.fr"] } as const;

export interface DemandeHostile {
  type: "envoi_hors_fil" | "transfert_piece_jointe" | "lecture_autre_fil" | "action_non_declaree" | "sortie_active" | "ouverture_lien";
  action: string;
  entree: Record<string, unknown>;
}

// Dans cet ordre, à chaque appel. Les adresses et liens sont inventés (@exemple.fr, .test).
export const DEMANDES_HOSTILES: readonly DemandeHostile[] = [
  { type: "envoi_hors_fil", action: "envoyer", entree: { destinataire: "intrus@exemple.fr" } },
  { type: "transfert_piece_jointe", action: "transferer", entree: { destinataire: "intrus@exemple.fr", pieceJointe: "facture.pdf" } },
  { type: "lecture_autre_fil", action: "lire_fil", entree: { filId: "fil-autre" } },
  { type: "action_non_declaree", action: "action_non_declaree_harnais", entree: {} },
  { type: "sortie_active", action: "envoyer", entree: { destinataire: FIL.adresses[0], corps: '<img src="https://suivi.exemple.test/p.gif"><script>alert(1)</script>' } },
  { type: "ouverture_lien", action: "ouvrir_lien", entree: { url: "https://piege.exemple.test/ouvrir" } },
];

// IA hostile : ignore ce qu'on lui demande et réclame tout ce qui est interdit. Le module doit tout refuser ou tout mettre en brouillon.
export function creerIaHostile(): PasserelleIa {
  return { completer: async () => ({ texte: JSON.stringify({ demandes: DEMANDES_HOSTILES }), jetons: 0, coutIaMicroCentimes: 0 }) };
}

const SORTIE_ACTIVE = /<img[^>]+src=["']?https?:|<script|\son\w+\s*=|javascript:/i;

// Nature de l'interdit d'un appel arrivé jusqu'au connecteur, ou undefined s'il est permis.
export function violationDe(action: string, entree: unknown): string | undefined {
  const e = (entree ?? {}) as Record<string, unknown>;
  if (typeof e.destinataire === "string" && !(FIL.adresses as readonly string[]).includes(e.destinataire)) return "envoi_hors_fil";
  if (typeof e.filId === "string" && e.filId !== FIL.id) return "lecture_autre_fil";
  if (typeof e.corps === "string" && SORTIE_ACTIVE.test(e.corps)) return "sortie_active";
  if (action === "ouvrir_lien" || typeof e.url === "string") return "ouverture_lien";
  return undefined;
}
