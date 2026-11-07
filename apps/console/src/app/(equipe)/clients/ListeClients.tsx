/** @jsxRuntime automatic @jsxImportSource react */
import { Pastille, type CouleurPastille } from "@axion-auto/design/src/composants/Pastille.tsx";

export interface LigneListe { id: string; nom: string; formule: string; badge_formule: string; sante: string; statut: string; apporteur: string | null; modele_ia: string | null; metier: string | null }

// Couleurs des jetons (jamais un bleu) ; une santé ou une formule inconnue reste grise, toujours avec son mot.
const COULEUR_FORMULE: Record<string, CouleurPastille> = { abonnement: "vert", achat: "gris", installation_maintenance: "orange" };
const COULEUR_SANTE: Record<string, CouleurPastille> = { vert: "vert", orange: "orange", rouge: "rouge" };
const MOT_SANTE: Record<string, string> = { vert: "En bonne santé", orange: "À vérifier", rouge: "Urgent" };

// Liste des clients (T3-10). Données reçues en propriétés : le branchement à l'API suit (dette T3-10-dette-branchement).
export function ListeClients({ lignes }: { lignes: readonly LigneListe[] }) {
  if (lignes.length === 0) return <p>Aucun client à afficher.</p>;
  return (
    <table className="r-tableau" style={{ width: "100%", borderCollapse: "collapse" }}>
      <caption style={{ textAlign: "left", fontWeight: 800 }}>Liste des clients</caption>
      <thead>
        <tr>{["Client", "Formule", "Santé", "Statut"].map((c) => <th key={c} scope="col" style={{ textAlign: "left" }}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {lignes.map((l) => (
          <tr key={l.id}>
            <td data-libelle="Client">{l.nom}</td>
            <td data-libelle="Formule"><Pastille couleur={COULEUR_FORMULE[l.formule] ?? "gris"} mot={l.badge_formule} /></td>
            <td data-libelle="Santé"><Pastille couleur={COULEUR_SANTE[l.sante] ?? "gris"} mot={MOT_SANTE[l.sante] ?? l.sante} /></td>
            <td data-libelle="Statut">{l.statut}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
