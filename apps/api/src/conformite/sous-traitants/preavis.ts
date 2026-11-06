import type { SousTraitant } from "./liste.js";

// Préavis de 30 jours avant tout ajout ou remplacement de sous-traitant (C-032). Dates au format AAAA-MM-JJ, calcul en UTC.
export const PREAVIS_JOURS = 30;

export interface Annonce {
  id: string;
  sousTraitant: SousTraitant;
  annonceLe: string;
  dateEffet: string;
}

export function ajouterJours(date: string, jours: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + jours);
  return d.toISOString().slice(0, 10);
}

export const enVigueur = (a: Annonce, aujourdhui: string): boolean => aujourdhui >= a.dateEffet;

// Garde de la passerelle : un fournisseur annoncé n'est pas utilisable avant sa date d'effet (interrupteur fermé).
export function exigerEnVigueur(a: Annonce, aujourdhui: string): void {
  if (!enVigueur(a, aujourdhui)) throw new Error(`préavis en cours jusqu'au ${a.dateEffet} : ${a.sousTraitant.nom} n'est pas utilisable`);
}

// La date d'effet ne peut que reculer dans le temps futur : jamais sous annonce + 30 jours, jamais avant l'actuelle.
export function reporterDateEffet(a: Annonce, nouvelle: string): Annonce {
  if (nouvelle < ajouterJours(a.annonceLe, PREAVIS_JOURS)) throw new Error("la date d'effet doit rester à 30 jours au moins de l'annonce");
  if (nouvelle < a.dateEffet) throw new Error("la date d'effet ne peut pas être avancée");
  return { ...a, dateEffet: nouvelle };
}

export interface JournalAnnonces {
  annonce(id: string): Annonce | undefined;
  enregistrer(a: Annonce): void;
  dejaEnvoye(cle: string): boolean;
  marquerEnvoye(cle: string): void;
}

export function journalAnnoncesEnMemoire(): JournalAnnonces {
  const annonces = new Map<string, Annonce>();
  const envoyes = new Set<string>();
  return {
    annonce: (id) => annonces.get(id),
    enregistrer: (a) => void annonces.set(a.id, a),
    dejaEnvoye: (c) => envoyes.has(c),
    marquerEnvoye: (c) => void envoyes.add(c),
  };
}

export interface DepsAnnonce {
  journal: JournalAnnonces;
  clientsActifs(): Promise<string[]>;
  // Notification de service (table des envois C-557) ; la clé anti-doublon inclut le client et l'annonce.
  envoyer(m: { clientId: string; cle: string; annonceId: string }): Promise<void>;
}

// Idempotent : rappelée, elle rattrape les clients entrés pendant le préavis sans réécrire l'annonce ni renvoyer aux autres.
export async function annoncer(deps: DepsAnnonce, st: SousTraitant, annonceLe: string): Promise<Annonce> {
  const id = `annonce-${st.id}-${annonceLe}`;
  const a = deps.journal.annonce(id) ?? { id, sousTraitant: st, annonceLe, dateEffet: ajouterJours(annonceLe, PREAVIS_JOURS) };
  deps.journal.enregistrer(a);
  for (const clientId of await deps.clientsActifs()) {
    const cle = `sous_traitant_annonce:${clientId}:${a.id}`;
    if (deps.journal.dejaEnvoye(cle)) continue;
    await deps.envoyer({ clientId, cle, annonceId: a.id });
    deps.journal.marquerEnvoye(cle);
  }
  return a;
}
