import { CODES_FAUX_MAX, INVITATION_JOURS, LOGO_MO_MAX, MOT_DE_PASSE_MIN, PAUSE_MINUTES, PIECE_JOINTE_MO_MAX } from "./valeurs.js";

export interface Message {
  titre: string;
  phrase: string;
  bouton?: string;
  variables?: string[];
}

// Un texte, et un seul, par cas : chaque écran le reprend tel quel, par sa clé.
export const messages = {
  // États vides
  "vide.console.accueilZeroClient": {
    titre: "Bienvenue, {prenom}. Pas encore de client ici.",
    phrase: "Vos clients arrivent depuis le CRM. Créez le premier : il apparaîtra ici avec ses automatisations et ses factures.",
    bouton: "Créer votre premier client depuis le CRM",
    variables: ["prenom"],
  },
  "vide.console.accueilJourneeCalme": {
    titre: "Rien à régler aujourd'hui, {prenom}.",
    phrase: "Aucune alerte, aucune demande en attente, aucun impayé. Vos {nbClients} clients tournent normalement ; la console vous préviendra au besoin.",
    bouton: "Voir les renouvellements",
    variables: ["prenom", "nbClients"],
  },
  "vide.console.alertes": {
    titre: "Tout est traité.",
    phrase: "Aucune alerte : tout fonctionne chez vos {nbClients} clients. Vous êtes prévenu dès qu'il se passe quelque chose.",
    bouton: "Voir ce qui a été réglé cette semaine",
    variables: ["nbClients"],
  },
  "vide.console.facturation": {
    titre: "Pas encore de facture.",
    phrase: "La première se prépare toute seule quand vous activez une automatisation chez un client. Vous la relisez avant qu'elle parte.",
    bouton: "Activer une automatisation",
  },
  "vide.console.demandes": {
    titre: "Aucune demande en attente.",
    phrase: "Vos clients sont servis. Quand l'un d'eux écrit depuis son portail, sa demande arrive ici.",
    bouton: "Voir les demandes terminées",
  },
  "vide.portail.accueilAvantLancement": {
    titre: "Lancement en cours",
    phrase: "Nous finissons de tout préparer. Vous serez prévenu dès que c'est prêt, vous n'avez rien à faire.",
    bouton: "Voir mes automatisations",
  },
  "vide.portail.accueilPremierMois": {
    titre: "Vos premiers chiffres arrivent demain.",
    phrase: "Le tri a commencé. La courbe du temps gagné (estimation) apparaît après deux mois, quand elle a vraiment quelque chose à dire.",
    bouton: "Voir mes automatisations",
  },
  "vide.portail.aRelire": {
    titre: "Tout est à jour.",
    phrase: "Aucune réponse à relire pour le moment. Nous vous prévenons dès qu'un message attend votre accord.",
    bouton: "Voir les réponses envoyées",
  },
  "vide.portail.factures": {
    titre: "Votre première facture arrivera le {datePremiereFacture}.",
    phrase: "Elle se règle par virement. Nos coordonnées sont déjà prêtes, vous pouvez les enregistrer dès maintenant.",
    bouton: "Voir nos coordonnées de virement",
    variables: ["datePremiereFacture"],
  },
  "vide.portail.demandes": {
    titre: "Vous n'avez pas de demande en cours.",
    phrase: "Une question, un réglage à changer, une nouvelle idée ? Écrivez-nous.",
    bouton: "Faire une demande",
  },

  // Erreurs : ce qui s'est passé, ce qui est gardé, quoi faire
  "erreur.invitationExpiree": {
    titre: "Ce lien d'invitation n'est plus valable",
    phrase: `Par sécurité, un lien d'invitation est valable ${INVITATION_JOURS} jours et ne sert qu'une fois. Votre espace est prêt et rien n'a été effacé : il suffit d'un nouveau lien.`,
    bouton: "Recevoir une nouvelle invitation",
  },
  "erreur.motDePasseFaux": {
    titre: "Ce mot de passe n'a pas été accepté",
    phrase: "Votre compte et vos données sont intacts. Vérifiez le mot de passe et réessayez, ou choisissez-en un nouveau.",
    bouton: "Choisir un nouveau mot de passe",
  },
  "erreur.comptePause": {
    titre: `Après ${CODES_FAUX_MAX} codes faux, l'accès est en pause`,
    phrase: `Pour protéger votre compte, l'accès se met en pause ${PAUSE_MINUTES} minutes. Votre compte et vos données sont intacts. Réessayez à la fin de la pause.`,
    bouton: "Choisir un nouveau mot de passe",
  },
  "erreur.codeVerificationFaux": {
    titre: "Ce code n'a pas été accepté",
    phrase: "Le code change souvent : celui-ci était peut-être déjà périmé. Votre mot de passe est bon, inutile de le retaper.",
    bouton: "Essayer avec le nouveau code",
  },
  "erreur.motDePasseTropCourt": {
    titre: "Ce mot de passe est trop court",
    phrase: `Il faut ${MOT_DE_PASSE_MIN} caractères au moins. Ce que vous avez saisi est gardé : ajoutez quelques caractères.`,
    bouton: "Modifier le mot de passe",
  },
  "erreur.accordAdminMicrosoft": {
    titre: "Microsoft demande l'accord de votre responsable informatique",
    phrase: "Dans votre entreprise, seul l'administrateur du compte Microsoft peut autoriser un nouvel outil. Cette étape passe en attente : vous continuez les suivantes sans attendre.",
    bouton: "Envoyer le lien à mon responsable",
  },
  "erreur.mauvaisCompteMicrosoft": {
    titre: "Ce n'est pas le compte Microsoft relié",
    phrase: "Vous avez choisi {compteChoisi} ; le compte relié est {compteRelie}. Nous n'avons rien changé : le compte relié et ses e-mails en attente sont intacts.",
    bouton: "Recommencer avec le bon compte",
    variables: ["compteChoisi", "compteRelie"],
  },
  "erreur.envoiRefuseOutlook": {
    titre: "Votre messagerie n'a pas accepté l'envoi",
    phrase: "Rien n'est perdu : la réponse est gardée telle quelle, prête à repartir. Si cela recommence, reconnectez votre messagerie.",
    bouton: "Réessayer l'envoi",
  },
  "erreur.hubInjoignableEmettre": {
    titre: "La facture n'a pas pu être émise",
    phrase: "Le logiciel de facturation ne répond pas pour le moment. La facture reste en brouillon : rien n'a été envoyé au client et rien n'est émis deux fois. Réessayez dans un instant.",
    bouton: "Réessayer d'émettre",
  },
  "erreur.exportImpossible": {
    titre: "L'export n'a pas pu être préparé",
    phrase: "La préparation du fichier s'est interrompue. Vos données sont intactes : l'export suivant repart de zéro.",
    bouton: "Relancer l'export",
  },
  "erreur.logoRefuse": {
    titre: "Ce logo n'a pas été accepté",
    phrase: `Seuls les fichiers PNG, JPEG ou WebP de ${LOGO_MO_MAX} Mo au plus sont acceptés ; le SVG est refusé. Le logo actuel reste affiché.`,
    bouton: "Choisir un autre fichier",
  },
  "erreur.pieceJointeTropLourde": {
    titre: "Ce fichier est trop lourd",
    phrase: `Un fichier peut peser ${PIECE_JOINTE_MO_MAX} Mo au plus. Un PDF compressé ou une photo plus petite passera. Le texte de votre demande et les autres fichiers sont gardés.`,
    bouton: "Choisir un autre fichier",
  },
  "erreur.sessionExpiree": {
    titre: "Votre session a pris fin",
    phrase: "Par sécurité, la session se ferme après un certain temps. Ce que vous étiez en train d'écrire est gardé : vous le retrouvez au même endroit.",
    bouton: "Me reconnecter",
  },
  "erreur.horsLigneTelephone": {
    titre: "Vous êtes hors ligne",
    phrase: "Votre téléphone n'a plus de connexion internet. Ce qui est affiché reste lisible ; tout se met à jour au retour du réseau.",
    bouton: "Réessayer",
  },
  "erreur.brouillonExpire": {
    titre: "Ce brouillon a expiré",
    phrase: "Un brouillon est gardé {dureeExpiration}. Celui-ci n'est plus disponible, rien d'autre n'a été touché. Vous pouvez en préparer un nouveau.",
    bouton: "Préparer un nouveau brouillon",
    variables: ["dureeExpiration"],
  },
  "erreur.horsLigneGeste": {
    titre: "Vous êtes hors ligne",
    phrase: "Vous êtes hors ligne. Rien n'a été envoyé. Réessayez quand le réseau revient.",
    bouton: "Réessayer",
  },
} satisfies Record<string, Message>;

export type CleMessage = keyof typeof messages;
