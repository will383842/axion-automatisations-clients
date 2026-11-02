# Politique « donnees » (T2-36) : jeton à part (DONNEES) du seul dossier apps/api/src/courtier. Lecture seule, deux familles de chemins :
# le mot de passe de l'exécuteur (secret app d'un client, A-209) et l'identifiant dynamique de lecture seule d'une heure (accès humain tracé, A-211).
# Aucun autre secret du dossier des bases (propriétaire, lecture, provisionneur, administration de PgBouncer) ; aucun droit sur la configuration du moteur database/.
# Le joker * n'est valable qu'en dernier caractère d'un chemin : le segment du client est donc un « + » (un segment entier).
# courtier.hcl reste inchangé : les tests C-012 et C-015 interdisent à ce rôle tout chemin technique/.
path "technique/data/donnees/+/app" {
  capabilities = ["read"]
}
path "technique/metadata/donnees/+/app" {
  capabilities = ["read"]
}
path "database/creds/humain-lecture-cli" {
  capabilities = ["read"]
}
