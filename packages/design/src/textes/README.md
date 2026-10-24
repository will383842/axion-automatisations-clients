# Catalogue des messages

Un texte, et un seul, par cas. Chaque écran le reprend tel quel, par sa clé (`messages.fr.ts`).
Les valeurs {entre accolades} sont des variables ; les nombres viennent de `valeurs.ts`.
Les maquettes F-Etats-Vides (empreinte 6124a0361a3e) et F-Messages-Erreur (empreinte 477a1dda3c39), style blocs colorés, ont servi de base.

## États vides

### `vide.console.accueilZeroClient`
- Titre : Bienvenue, {prenom}. Pas encore de client ici.
- Phrase : Vos clients arrivent depuis le CRM. Créez le premier : il apparaîtra ici avec ses automatisations et ses factures.
- Bouton : Créer votre premier client depuis le CRM
- Variables : prenom

### `vide.console.accueilJourneeCalme`
- Titre : Rien à régler aujourd'hui, {prenom}.
- Phrase : Aucune alerte, aucune demande en attente, aucun impayé. Vos {nbClients} clients tournent normalement ; la console vous préviendra au besoin.
- Bouton : Voir les renouvellements
- Variables : prenom, nbClients

### `vide.console.alertes`
- Titre : Tout est traité.
- Phrase : Aucune alerte : tout fonctionne chez vos {nbClients} clients. Nous vous prévenons dès qu'il se passe quelque chose.
- Bouton : Voir ce qui a été réglé cette semaine
- Variables : nbClients

### `vide.console.facturation`
- Titre : Pas encore de facture.
- Phrase : La première se prépare toute seule quand vous activez une automatisation chez un client. Vous la relisez avant qu'elle parte.
- Bouton : Activer une automatisation

### `vide.console.demandes`
- Titre : Aucune demande en attente.
- Phrase : Vos clients sont servis. Quand l'un d'eux écrit depuis son portail, sa demande arrive ici.
- Bouton : Voir les demandes terminées

### `vide.portail.accueilAvantLancement`
- Titre : Lancement en cours
- Phrase : Nous finissons de tout préparer. Nous vous prévenons dès que c'est prêt ; vous n'avez rien à faire.
- Bouton : Voir mes automatisations

### `vide.portail.accueilPremierMois`
- Titre : Vos premiers chiffres arrivent demain.
- Phrase : Le tri a commencé. La courbe du temps gagné (estimation) apparaît après deux mois, quand elle a vraiment quelque chose à dire.
- Bouton : Voir mes automatisations

### `vide.portail.aRelire`
- Titre : Tout est à jour.
- Phrase : Aucune réponse à relire pour le moment. Nous vous prévenons dès qu'un message attend votre accord.
- Bouton : Voir les réponses envoyées

### `vide.portail.factures`
- Titre : Votre première facture arrivera le {datePremiereFacture}.
- Phrase : Elle se règle par virement. Nos coordonnées sont déjà prêtes, vous pouvez les enregistrer dès maintenant.
- Bouton : Voir nos coordonnées de virement
- Variables : datePremiereFacture

### `vide.portail.demandes`
- Titre : Vous n'avez pas de demande en cours.
- Phrase : Une question, un réglage à changer, une nouvelle idée ? Écrivez-nous.
- Bouton : Faire une demande

## Erreurs

### `erreur.invitationExpiree`
- Titre : Ce lien d'invitation n'est plus valable
- Phrase : Par sécurité, un lien d'invitation est valable 7 jours et ne sert qu'une fois. Votre espace est prêt et rien n'a été effacé : il suffit d'un nouveau lien.
- Bouton : Recevoir une nouvelle invitation

### `erreur.motDePasseFaux`
- Titre : Ce mot de passe n'a pas été accepté
- Phrase : Votre compte et vos données sont intacts. Vérifiez le mot de passe et réessayez, ou choisissez-en un nouveau.
- Bouton : Choisir un nouveau mot de passe

### `erreur.comptePause`
- Titre : Après 5 codes faux, l'accès est en pause
- Phrase : Pour protéger votre compte, l'accès se met en pause 15 minutes. Votre compte et vos données sont intacts. Réessayez à la fin de la pause.
- Bouton : Revenir à la connexion

### `erreur.codeVerificationFaux`
- Titre : Ce code n'a pas été accepté
- Phrase : Le code change souvent : celui-ci était peut-être déjà périmé. Votre mot de passe est bon, inutile de le retaper.
- Bouton : Essayer avec le nouveau code

### `erreur.motDePasseTropCourt`
- Titre : Ce mot de passe est trop court
- Phrase : Il faut 12 caractères au moins. Ce que vous avez saisi est gardé : ajoutez quelques caractères.
- Bouton : Modifier le mot de passe

### `erreur.accordAdminMicrosoft`
- Titre : Microsoft demande l'accord de votre responsable informatique
- Phrase : Dans votre entreprise, seul l'administrateur du compte Microsoft peut autoriser un nouvel outil. Cette étape passe en attente : vous continuez les suivantes sans attendre.
- Bouton : Envoyer le lien à mon responsable

### `erreur.mauvaisCompteMicrosoft`
- Titre : Ce n'est pas le compte Microsoft relié
- Phrase : Vous avez choisi {compteChoisi} ; le compte relié est {compteRelie}. Nous n'avons rien changé : le compte relié et ses e-mails en attente sont intacts.
- Bouton : Recommencer avec le bon compte
- Variables : compteChoisi, compteRelie

### `erreur.envoiRefuseOutlook`
- Titre : Votre messagerie n'a pas accepté l'envoi
- Phrase : Rien n'est perdu : la réponse est gardée telle quelle, prête à repartir. Si cela recommence, reconnectez votre messagerie.
- Bouton : Réessayer l'envoi

### `erreur.hubInjoignableEmettre`
- Titre : La facture n'a pas pu être émise
- Phrase : Le logiciel de facturation ne répond pas pour le moment. La facture reste en brouillon : rien n'a été envoyé au client et rien n'est émis deux fois. Réessayez dans un instant.
- Bouton : Réessayer d'émettre

### `erreur.exportImpossible`
- Titre : L'export n'a pas pu être préparé
- Phrase : La préparation du fichier s'est interrompue. Vos données sont intactes : l'export suivant repart de zéro.
- Bouton : Relancer l'export

### `erreur.logoRefuse`
- Titre : Ce logo n'a pas été accepté
- Phrase : Seuls les fichiers PNG, JPEG ou WebP de 1 Mo au plus sont acceptés ; le SVG est refusé. Le logo actuel reste affiché.
- Bouton : Choisir un autre fichier

### `erreur.pieceJointeTropLourde`
- Titre : Ce fichier est trop lourd
- Phrase : Un fichier peut peser 10 Mo au plus. Un PDF compressé ou une photo plus petite passera. Le texte de votre demande et les autres fichiers sont gardés.
- Bouton : Choisir un autre fichier

### `erreur.sessionExpiree`
- Titre : Votre session a pris fin
- Phrase : Par sécurité, la session se ferme après un certain temps. Ce que vous étiez en train d'écrire est gardé : vous le retrouvez au même endroit.
- Bouton : Me reconnecter

### `erreur.horsLigneTelephone`
- Titre : Vous êtes hors ligne
- Phrase : Votre téléphone n'a plus de connexion internet. Ce qui est affiché reste lisible ; tout se met à jour au retour du réseau.
- Bouton : Réessayer

### `erreur.brouillonExpire`
- Titre : Ce brouillon a expiré
- Phrase : Un brouillon est gardé {dureeExpiration}. Celui-ci n'est plus disponible, rien d'autre n'a été touché. Vous pouvez en préparer un nouveau.
- Bouton : Préparer un nouveau brouillon
- Variables : dureeExpiration

### `erreur.horsLigneGeste`
- Titre : Vous êtes hors ligne
- Phrase : Vous êtes hors ligne. Rien n'a été envoyé. Réessayez quand le réseau revient.
- Bouton : Réessayer

