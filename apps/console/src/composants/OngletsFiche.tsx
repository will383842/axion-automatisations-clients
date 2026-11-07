import type { ReactNode } from "react";
import { Carte } from "@axion-auto/design/src/composants/base.tsx";
import { ongletsLivres, type FicheClient } from "../fiche/onglets.ts";
import { BandeauSante } from "./BandeauSante.tsx";

const v = (n: string) => `var(--${n})`;
const adresse = (id: string, segment: string) => `/clients/${id}${segment ? `/${segment}` : ""}`;

/** Barre d'onglets de la fiche : seuls les onglets livrés (B-002). */
export function OngletsFiche({ id, actif }: { id: string; actif: string }) {
  return (
    <nav aria-label="Onglets de la fiche" style={{ display: "flex", flexWrap: "wrap", gap: v("espacement-16"), padding: v("espacement-8") }}>
      {ongletsLivres().map((o) => (
        <a key={o.cle} href={adresse(id, o.segment)} aria-current={o.cle === actif ? "page" : undefined}>{o.libelle}</a>
      ))}
    </nav>
  );
}

/** Coque de la fiche : le bandeau est au-dessus de chaque onglet (B-035). */
export function CoqueFiche({ id, fiche, actif, children }: { id: string; fiche: FicheClient; actif: string; children: ReactNode }) {
  return (
    <div>
      <BandeauSante bandeau={fiche.bandeau} />
      <OngletsFiche id={id} actif={actif} />
      <div>{children}</div>
    </div>
  );
}

const pourcent = (n: number | null) => (n === null ? "pas encore de mesure" : `${n.toLocaleString("fr-FR")} % réussies`);

/** Résumé (B-036, A-025) : un bloc par sujet, chacun renvoie à son onglet. */
export function ResumeFiche({ id, resume }: { id: string; resume: FicheClient["resume"] }) {
  const blocs: { titre: string; texte: string; segment: string }[] = [
    { titre: "Abonnement", texte: `Formule ${resume.abonnement.formule}${resume.abonnement.engagement ? ` · engagement ${resume.abonnement.engagement}` : ""}`, segment: "contrat" },
    { titre: "Automatisations", texte: `${resume.automatisations_actives} actives`, segment: "automatisations" },
    { titre: "Réglages", texte: `${resume.reglages.versions} versions`, segment: "reglages" },
    { titre: "Connexions", texte: `${resume.connexions.a_reprendre} sur ${resume.connexions.total} à reprendre`, segment: "outils" },
    { titre: "Exécutions", texte: `${pourcent(resume.executions.reussies_pourcent)} · ${resume.executions.en_attente} en attente`, segment: "sante" },
    { titre: "Notes", texte: `${resume.notes.total} notes dont ${resume.notes.epinglees} épinglées`, segment: "notes" },
    { titre: "Factures", texte: `${resume.factures.en_attente} en attente`, segment: "factures" },
  ];
  return (
    <section aria-label="Résumé du client" style={{ display: "grid", gap: v("espacement-12"), padding: v("espacement-12") }}>
      {blocs.map((b) => (
        <Carte key={b.titre}>
          <h2 style={{ margin: 0, fontSize: v("taille-soustitre") }}>{b.titre}</h2>
          <p style={{ margin: 0 }}>{b.texte}</p>
          <a href={adresse(id, b.segment)}>Voir {b.titre.toLowerCase()}</a>
        </Carte>
      ))}
    </section>
  );
}
