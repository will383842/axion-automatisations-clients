# Politique « donnees » (T2-36, T2-36b, ADR 0113) : jeton à part (DONNEES) du seul dossier apps/api/src/courtier. Lecture seule de DEUX familles de chemins :
# les mots de passe de l'exécuteur, secret app et secret lecture d'un client (A-209). La lecture déclarée du port données est servie avec lecture, jamais avec app.
# L'accès humain (A-211) a sa propre politique « humains » et son propre jeton (HUMAINS), posés par initialiser.sh.
# Aucun autre secret du dossier des bases (propriétaire, provisionneur, administration de PgBouncer) ; aucun droit sur le moteur database/.
# Le joker * n'est valable qu'en dernier caractère d'un chemin : le segment du client est donc un « + » (un segment entier).
# courtier.hcl reste inchangé : les tests C-012 et C-015 interdisent à ce rôle tout chemin technique/.
path "technique/data/donnees/+/app" {
  capabilities = ["read"]
}
path "technique/metadata/donnees/+/app" {
  capabilities = ["read"]
}
path "technique/data/donnees/+/lecture" {
  capabilities = ["read"]
}
path "technique/metadata/donnees/+/lecture" {
  capabilities = ["read"]
}
