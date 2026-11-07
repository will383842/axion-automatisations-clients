// Brouillon à relire par Will à la porte B.
// Glossaire de la console : une phrase par mot, écrite pour l'équipe, en français simple.
// Rangé par ordre alphabétique sans tenir compte des accents (le test le vérifie).

export interface EntreeGlossaire {
  mot: string;
  definition: string;
}

export interface Raccourci {
  /** Touches équivalentes : « Ctrl » ou « Cmd » + « K » s'écrit ["Ctrl", "Cmd", "K"]. */
  touches: readonly string[];
  effet: string;
}

export const glossaire: readonly EntreeGlossaire[] = [
  { mot: "AIPD", definition: "Analyse d'impact sur la protection des données : le document qui mesure les risques d'un traitement de données avant de le lancer." },
  { mot: "Brouillon", definition: "Texte ou réglage enregistré mais pas encore validé : le client ne le voit pas tant qu'il n'est pas publié." },
  { mot: "Clé d'accès", definition: "Code secret qui permet à un outil de se connecter à un service à la place d'une personne." },
  { mot: "Connecteur", definition: "Petit module qui relie l'automatisation à un outil du client, par exemple sa messagerie ou son agenda." },
  { mot: "Disjoncteur", definition: "Arrêt automatique d'une automatisation qui échoue trop souvent, pour éviter d'aggraver la panne." },
  { mot: "Double facteur", definition: "Seconde vérification, par exemple un code reçu sur le téléphone, demandée en plus du mot de passe." },
  { mot: "Engagement", definition: "Durée pendant laquelle le client s'est engagé à garder son contrat avant de pouvoir le quitter." },
  { mot: "Gamme d'IA", definition: "Niveau de puissance du modèle d'intelligence artificielle utilisé par une automatisation." },
  { mot: "Instance", definition: "Exemplaire d'une automatisation installé et réglé pour un client précis." },
  { mot: "Niveau de service", definition: "Engagement sur la rapidité de prise en charge et de réponse quand le client signale un problème." },
  { mot: "Page d'état", definition: "Page publique qui indique si les services fonctionnent et résume les incidents en cours." },
  { mot: "Palier", definition: "Étape d'une grille où les conditions changent selon le volume ou le niveau d'usage du client." },
  { mot: "Période payée d'avance", definition: "Durée déjà réglée par le client, pendant laquelle aucune nouvelle facture n'est émise." },
  { mot: "Sous-traitant", definition: "Entreprise extérieure qui traite des données pour notre compte ou celui du client." },
];

export const raccourcis: readonly Raccourci[] = [
  { touches: ["Ctrl", "Cmd", "K"], effet: "Ouvre la recherche, depuis n'importe quel écran de la console." },
  { touches: ["Entrée"], effet: "Ouvre le résultat choisi." },
  { touches: ["Échap"], effet: "Ferme la recherche sans rien ouvrir." },
  { touches: ["↑"], effet: "Choisit le résultat précédent." },
  { touches: ["↓"], effet: "Choisit le résultat suivant." },
];
