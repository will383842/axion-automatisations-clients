// Catalogue des e-mails de service (C-557) : un texte par ligne de TABLE_ENVOIS, rien d'autre.
// Texte brut en V1 : ni logo image ni pièce jointe (un document est annoncé par un lien).
// Brouillons réduits, tous « a_valider » : une garde de l'API refusera de les envoyer
// tant que Will n'a pas validé chaque texte par écrit. Aucun chiffre ni montant en dur :
// seuil, délai, mois et numéro de facture passent par des variables.
// Ce fichier n'importe rien du catalogue d'écran (dépendance interdite).

export type ValidationTexte = "a_valider" | { will: string };

export interface TexteEmail {
  sujet: string;
  corps: string;
  bouton?: string;
  variables: readonly string[];
  validation: ValidationTexte;
}

export const PIED_EMAIL = "Ceci est un e-mail de service, sans publicité. Une question : {adresseSupport}.";

const MARQUE = "AXION IA";

const t = (
  sujet: string,
  phrases: readonly string[],
  variables: readonly string[],
  lien?: { bouton: string; variable: string },
): TexteEmail => ({
  sujet,
  corps: [MARQUE, ...phrases, ...(lien ? [`${lien.bouton} : {${lien.variable}}`] : []), PIED_EMAIL].join("\n\n"),
  ...(lien ? { bouton: lien.bouton } : {}),
  variables: [...variables, "adresseSupport"],
  validation: "a_valider",
});

export const CATALOGUE_EMAILS = {
  "email.invitationPortail": t(
    "Votre espace client AXION IA est prêt",
    ["Bonjour, l'espace client de {nomEntreprise} est ouvert.", "Vous y suivez vos automatisations et ce qui demande votre accord."],
    ["nomEntreprise", "lienInvitation"],
    { bouton: "Ouvrir mon espace", variable: "lienInvitation" },
  ),
  "email.invitationCollegue": t(
    "Vous êtes invité à rejoindre l'espace de {nomEntreprise}",
    ["Bonjour, un collègue vous invite à rejoindre l'espace client de {nomEntreprise}."],
    ["nomEntreprise", "lienInvitation"],
    { bouton: "Accepter l'invitation", variable: "lienInvitation" },
  ),
  "email.cestParti": t(
    "C'est parti : {nomAutomatisation} est en route",
    ["Bonjour, l'automatisation {nomAutomatisation} vient de démarrer.", "Vous pouvez suivre son avancement depuis votre espace."],
    ["nomAutomatisation", "lienEspace"],
    { bouton: "Voir l'avancement", variable: "lienEspace" },
  ),
  "email.lancementEnCours": t(
    "Lancement en cours : {nomAutomatisation}",
    ["Bonjour, le lancement de {nomAutomatisation} est en cours.", "Nous vous écrivons dès que tout est en place."],
    ["nomAutomatisation", "lienEspace"],
    { bouton: "Voir le lancement", variable: "lienEspace" },
  ),
  "email.lienReconnexion": t(
    "Reconnectez {nomConnexion} pour reprendre le travail",
    ["Bonjour, la connexion à {nomConnexion} ne répond plus.", "Il suffit de la renouveler pour que tout reprenne."],
    ["nomConnexion", "lienReconnexion"],
    { bouton: "Reconnecter", variable: "lienReconnexion" },
  ),
  "email.avisExpirationConnexion7Jours": t(
    "La connexion à {nomConnexion} expire bientôt",
    ["Bonjour, la connexion à {nomConnexion} expire {delai}.", "Renouvelez-la avant cette date pour éviter toute interruption."],
    ["nomConnexion", "delai", "lienReconnexion"],
    { bouton: "Renouveler la connexion", variable: "lienReconnexion" },
  ),
  "email.brouillonEnAttente": t(
    "Un brouillon attend votre relecture",
    ["Bonjour, un brouillon de {nomAutomatisation} attend votre relecture.", "Rien ne part sans votre accord."],
    ["nomAutomatisation", "lienEspace"],
    { bouton: "Relire le brouillon", variable: "lienEspace" },
  ),
  "email.brouillonExpire": t(
    "Un brouillon a expiré",
    ["Bonjour, le brouillon de {nomAutomatisation} n'a pas été relu à temps et a expiré.", "Rien n'a été envoyé. Un nouveau brouillon peut être demandé depuis votre espace."],
    ["nomAutomatisation", "lienEspace"],
    { bouton: "Ouvrir mon espace", variable: "lienEspace" },
  ),
  "email.envoiEnAttenteARelire": t(
    "Un envoi attend votre relecture",
    ["Bonjour, un envoi de {nomAutomatisation} est en attente.", "Relisez-le avant qu'il parte."],
    ["nomAutomatisation", "lienEspace"],
    { bouton: "Relire l'envoi", variable: "lienEspace" },
  ),
  "email.palier80Client": t(
    "Vous approchez de la limite de {nomAutomatisation}",
    ["Bonjour, vous avez atteint {seuil} de l'usage prévu pour {nomAutomatisation}.", "Vous pouvez suivre la consommation depuis votre espace."],
    ["nomAutomatisation", "seuil", "lienEspace"],
    { bouton: "Voir la consommation", variable: "lienEspace" },
  ),
  "email.palier100Client": t(
    "Limite atteinte pour {nomAutomatisation}",
    ["Bonjour, vous avez atteint {seuil} de l'usage prévu pour {nomAutomatisation}.", "Consultez votre espace pour connaître la suite."],
    ["nomAutomatisation", "seuil", "lienEspace"],
    { bouton: "Voir la consommation", variable: "lienEspace" },
  ),
  "email.palier80Will": t(
    "Palier atteint chez {nomEntreprise}",
    ["Bonjour, {nomEntreprise} a atteint {seuil} de l'usage prévu pour {nomAutomatisation}."],
    ["nomEntreprise", "nomAutomatisation", "seuil", "lienConsole"],
    { bouton: "Ouvrir la fiche", variable: "lienConsole" },
  ),
  "email.palier100Will": t(
    "Limite atteinte chez {nomEntreprise}",
    ["Bonjour, {nomEntreprise} a atteint {seuil} de l'usage prévu pour {nomAutomatisation}."],
    ["nomEntreprise", "nomAutomatisation", "seuil", "lienConsole"],
    { bouton: "Ouvrir la fiche", variable: "lienConsole" },
  ),
  "email.factureDisponible": t(
    "Votre facture {numeroFacture} est disponible",
    ["Bonjour, votre facture {numeroFacture} est disponible dans votre espace.", "Elle n'est pas jointe à ce message : vous la retrouvez et la téléchargez depuis votre espace."],
    ["numeroFacture", "lienEspace"],
    { bouton: "Voir ma facture", variable: "lienEspace" },
  ),
  "email.relanceImpaye": t(
    "Rappel : la facture {numeroFacture} reste à régler",
    ["Bonjour, nous n'avons pas encore reçu le règlement de la facture {numeroFacture}.", "Si c'est déjà fait, vous pouvez ignorer ce message."],
    ["numeroFacture", "lienEspace"],
    { bouton: "Voir ma facture", variable: "lienEspace" },
  ),
  "email.nonPaiement30Jours": t(
    "Facture {numeroFacture} impayée : merci de nous répondre",
    ["Bonjour, la facture {numeroFacture} reste impayée depuis plus d'un mois.", "Merci de la régler ou de nous écrire pour en parler."],
    ["numeroFacture", "lienEspace"],
    { bouton: "Voir ma facture", variable: "lienEspace" },
  ),
  "email.rapportMensuel": t(
    "Votre rapport du mois de {mois} est disponible",
    ["Bonjour, le rapport du mois de {mois} est prêt.", "Il n'est pas joint à ce message : vous le consultez depuis votre espace."],
    ["mois", "lienEspace"],
    { bouton: "Lire le rapport", variable: "lienEspace" },
  ),
  "email.notificationViolation": t(
    "Information importante sur votre compte",
    ["Bonjour, nous devons vous informer d'un événement concernant vos données.", "Le détail et les mesures à prendre sont dans votre espace."],
    ["lienEspace"],
    { bouton: "Lire l'information", variable: "lienEspace" },
  ),
} as const satisfies Record<string, TexteEmail>;
