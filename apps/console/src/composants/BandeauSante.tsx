import { BadgeEtat, Carte, type Etat } from "@axion-auto/design/src/composants/base.tsx";
import type { EtatClient, FicheClient } from "../fiche/onglets.ts";

const v = (n: string) => `var(--${n})`;
const ETAT: Record<EtatClient, { etat: Etat; mot: string }> = {
  ok: { etat: "fait", mot: "Tout va bien" },
  a_aider: { etat: "averifier", mot: "À aider" },
  urgent: { etat: "urgent", mot: "Urgent" },
  pause: { etat: "pause", mot: "En pause" },
};
const date = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// Bandeau de santé fixe (B-035, B-100) : état, formule, dernière erreur (code et message du catalogue, jamais de contenu), connexions, prochaine échéance.
export function BandeauSante({ bandeau }: { bandeau: FicheClient["bandeau"] }) {
  const e = ETAT[bandeau.etat];
  return (
    <header data-bandeau-sante="1" aria-label="Santé du client" style={{ position: "sticky", top: 0, zIndex: 1 }}>
      <Carte>
      <div style={{ display: "flex", flexWrap: "wrap", gap: v("espacement-16"), alignItems: "center" }}>
      <h1 style={{ margin: 0, fontSize: v("taille-titre") }}>{bandeau.nom}</h1>
      <BadgeEtat etat={e.etat} texte={e.mot} />
      <span>Formule {bandeau.formule}</span>
      <span>
        {bandeau.derniere_erreur ? <>Dernière erreur : <code>{bandeau.derniere_erreur.code}</code> · {bandeau.derniere_erreur.message}</> : "Aucune erreur récente."}
      </span>
      <span>Connexions : {bandeau.connexions.a_reprendre} sur {bandeau.connexions.total} à reprendre</span>
      <span>Prochaine échéance : {bandeau.prochaine_echeance ? date(bandeau.prochaine_echeance) : "aucune"}</span>
      </div>
      </Carte>
    </header>
  );
}
