/** @jsxRuntime automatic @jsxImportSource react */
import { Bandeau, Bouton, Carte } from "../src/index.ts";
import { monter, Page } from "./commun.tsx";

// Maquette F-Tel-Portail-Relire (version corrigée du tour 8) : une réponse à la fois. Personnes et sujets fictifs.
monter(
  <Page variante="portail" actif="arelire" compteurs={{ arelire: 4 }}>
    <div className="g-pile" style={{ maxWidth: "640px" }}>
      <header>
        <p className="g-note" style={{ margin: 0 }}>
          1 sur 4
        </p>
        <h1>Une réponse à relire</h1>
        <p>
          Claire, lisez tranquillement, puis choisissez juste en dessous. <strong>Rien ne part sans votre geste.</strong>
        </p>
      </header>
      <Carte>
        <h2>E-mail reçu de Sophie Garnier</h2>
        <p className="g-note">Reçu hier à 16 h 12 · Demande de devis, salle de bains</p>
        <Carte teinte="terracotta">
          <p style={{ margin: 0 }}>
            <strong>En résumé :</strong> Mme Garnier souhaite refaire sa salle de bains et demande un premier rendez-vous pour un devis. Elle est disponible en semaine, le matin ou en fin d'après-midi.
          </p>
        </Carte>
      </Carte>
      <Carte>
        <h2>Réponse proposée</h2>
        <p className="g-note">À : sophie.garnier@exemple.fr · Objet : Re: Demande de devis, salle de bains</p>
        <p>Bonjour Madame Garnier,</p>
        <p>Merci pour votre message. Claire Lemoine peut passer voir votre salle de bains le mardi 27 octobre à 10 h ou le jeudi 29 octobre à 15 h. La visite dure environ une heure.</p>
        <p className="g-note">Pourquoi ce brouillon : nouvelle personne qui demande un rendez-vous ; les deux créneaux sont libres dans votre agenda.</p>
        <div className="g-pile">
          <Bouton variante="principal">Accepter et envoyer</Bouton>
          <div className="g-rangee">
            <Bouton variante="secondaire">Modifier</Bouton>
            <Bouton variante="secondaire">Refuser</Bouton>
          </div>
        </div>
        <p className="g-note">Vous pouvez annuler pendant 10 secondes après l'envoi.</p>
        <Bandeau type="information">En attente de Microsoft 365. À la reconnexion, nous vous la remontrons pour vérifier les dates avant l'envoi. Rien n'est perdu.</Bandeau>
      </Carte>
    </div>
  </Page>,
);
