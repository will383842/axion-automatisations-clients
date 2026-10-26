/** @jsxRuntime automatic @jsxImportSource react */
import { BadgeEtat, Bouton, Carte, TableauCartes, TuileAutomatisation } from "../src/index.ts";
import { monter, Page } from "./commun.tsx";

// Maquette F-Portail-Automatisation (version corrigée du tour 8). Entreprise inventée, aucun montant.
const Chiffre = ({ valeur, libelle }: { valeur: string; libelle: string }) => (
  <Carte teinte="vert" liseret="haut">
    <p style={{ margin: 0, fontFamily: "var(--police-titre)", fontSize: "var(--taille-titrePage)", fontWeight: 600 }}>{valeur}</p>
    <p style={{ margin: 0 }}>{libelle}</p>
  </Carte>
);

monter(
  <Page variante="portail" actif="automatisations" compteurs={{ arelire: 4 }}>
    <div className="g-pile">
      <header className="g-rangee">
        <TuileAutomatisation identite="tri" nom="Tri des e-mails" />
        <div style={{ flex: "1 1 200px" }}>
          <h1 style={{ margin: 0 }}>Tri des e-mails</h1>
          <p style={{ margin: 0 }}>Votre boîte est triée toute la journée. Rien ne part sans votre geste.</p>
        </div>
        <BadgeEtat etat="fait" texte="En marche" />
      </header>
      <div className="g-grille r-grille">
        <Chiffre valeur="128" libelle="e-mails triés cette semaine" />
        <Chiffre valeur="4" libelle="réponses à relire" />
        <Chiffre valeur="0" libelle="e-mail perdu" />
      </div>
      <TableauCartes
        legende="Derniers e-mails triés"
        colonnes={["Reçu", "De", "Rangé dans"]}
        lignes={[
          ["Hier, 16 h 12", "Sophie Garnier", "Demandes de devis"],
          ["Hier, 14 h 03", "Atelier Bertin", "Fournisseurs"],
          ["Hier, 9 h 41", "Garage Fontaine", "Rendez-vous"],
        ]}
      />
      <Carte>
        <h2>Besoin d'une pause ?</h2>
        <p>Vous pouvez arrêter le tri quand vous voulez. Vos e-mails restent dans votre boîte et seront triés à la reprise.</p>
        <Bouton variante="secondaire">Mettre en pause</Bouton>
      </Carte>
    </div>
  </Page>,
);
