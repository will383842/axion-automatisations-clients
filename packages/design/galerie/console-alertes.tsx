/** @jsxRuntime automatic @jsxImportSource react */
import { BadgeEtat, Bouton, Carte, CaseACocher } from "../src/index.ts";
import { monter, Page } from "./commun.tsx";

// Maquette F-Console-Alertes (version corrigée du tour 8). Entreprises inventées, aucun montant.
const Alerte = ({ titre, texte, action }: { titre: string; texte: string; action: string }) => (
  <Carte>
    <h3>{titre}</h3>
    <p>{texte}</p>
    <Bouton variante="secondaire">{action}</Bouton>
  </Carte>
);

monter(
  <Page variante="console" actif="alertes" compteurs={{ clients: 42, alertes: 3, demandes: 5 }}>
    <div className="g-pile">
      <header>
        <h1>Alertes et santé</h1>
        <p>
          40 clients sur 42 vont bien. <strong>2 alertes</strong> demandent votre aide maintenant.
        </p>
      </header>
      <Carte teinte="terracotta" liseret="gauche">
        <div className="g-rangee">
          <BadgeEtat etat="urgent" texte="Incident en cours" />
          <h2 style={{ margin: 0 }}>Microsoft 365 répond lentement</h2>
        </div>
        <p>Côté fournisseur depuis 07 h 30 · 6 clients touchés · le tri des e-mails prend du retard, rien n'est perdu.</p>
        <label htmlFor="message-incident" style={{ fontWeight: 800, display: "block", marginBottom: "var(--espacement-8)" }}>
          Message aux 6 clients, à relire avant envoi
        </label>
        <textarea id="message-incident" className="g-champ" rows={4} defaultValue="Bonjour, Microsoft 365 répond lentement ce matin. Vos e-mails sont bien reçus : leur tri prendra simplement un peu de retard. Rien n'est perdu et vous n'avez rien à faire. L'équipe Axion IA" />
        <CaseACocher libelle="Publier aussi ce message sur la page d'état publique" defaultChecked />
        <div className="g-rangee">
          <Bouton variante="principal">J'ai relu, envoyer aux 6 clients</Bouton>
          <Bouton variante="secondaire">Voir les 6 clients</Bouton>
        </div>
      </Carte>
      <div className="g-grille r-grille">
        <Carte teinte="terracotta">
          <h2>À aider maintenant</h2>
          <div className="g-pile">
            <Alerte titre="Lemoine Rénovation" texte="Connexion Microsoft 365 expirée hier à 18 h · 142 e-mails attendent." action="Renvoyer le lien" />
            <Alerte titre="Garage Fontaine" texte="Résultat signalé faux : un e-mail rangé dans le mauvais dossier." action="Ouvrir la demande" />
          </div>
        </Carte>
        <Carte teinte="ambre">
          <h2>À surveiller</h2>
          <div className="g-pile">
            <Alerte titre="Boulangerie Rivoire" texte="Tri des e-mails : 880 sur 1 000 compris (88 %) · 8 jours avant la fin du mois." action="Voir la connexion" />
          </div>
        </Carte>
        <Carte teinte="vert">
          <h2>Réglé</h2>
          <p>
            <strong>Atelier Bertin</strong> · Microsoft 365 reconnecté hier, par le client.
          </p>
          <p>
            <strong>Immobilière Marceau</strong> · doublon de contact fusionné mercredi.
          </p>
        </Carte>
      </div>
      <Carte>
        <h2>Disjoncteurs</h2>
        <p>Pour couper vite si quelque chose cloche. Chaque coupure demande une confirmation, et la reprise se fait d'un clic.</p>
        <div className="g-grille r-grille">
          <div>
            <h3>Une automatisation</h3>
            <label htmlFor="choix-automatisation" style={{ fontWeight: 700, display: "block" }}>
              Client et automatisation
            </label>
            <select id="choix-automatisation" className="g-champ" defaultValue="a">
              <option value="a">Garage Fontaine · Tri des e-mails</option>
            </select>
            <p />
            <Bouton variante="secondaire">Mettre en pause</Bouton>
          </div>
          <div>
            <h3>Un connecteur</h3>
            <label htmlFor="choix-connecteur" style={{ fontWeight: 700, display: "block" }}>
              Connecteur
            </label>
            <select id="choix-connecteur" className="g-champ" defaultValue="m">
              <option value="m">Microsoft 365 · 6 clients</option>
            </select>
            <p />
            <Bouton variante="secondaire">Mettre en pause</Bouton>
          </div>
          <div>
            <h3>Tous les envois</h3>
            <p>Plus rien ne part chez aucun client. À réserver aux cas graves.</p>
            <Bouton variante="secondaire">Arrêter tous les envois</Bouton>
          </div>
        </div>
      </Carte>
    </div>
  </Page>,
);
