# Politique « donnees » (T2-36, T2-36b) : jeton à part (DONNEES) du seul dossier apps/api/src/courtier. Lecture seule d'UNE famille de chemins :
# le mot de passe de l'exécuteur (secret app d'un client, A-209). L'accès humain (A-211) a sa propre politique « humains » et son propre jeton (HUMAINS), posés par initialiser.sh.
# Aucun autre secret du dossier des bases (propriétaire, lecture, provisionneur, administration de PgBouncer) ; aucun droit sur le moteur database/.
# Le joker * n'est valable qu'en dernier caractère d'un chemin : le segment du client est donc un « + » (un segment entier).
# courtier.hcl reste inchangé : les tests C-012 et C-015 interdisent à ce rôle tout chemin technique/.
path "technique/data/donnees/+/app" {
  capabilities = ["read"]
}
path "technique/metadata/donnees/+/app" {
  capabilities = ["read"]
}
