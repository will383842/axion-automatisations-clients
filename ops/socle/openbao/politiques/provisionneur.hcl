# Provisionnement des bases des clients (T2-34) : le dossier apps/api/src/provisionnement seul porte ce jeton. Il range les mots de passe d'un client
# sans jamais les relire, et lit seulement les deux secrets dont il se sert pour agir sur la grappe : son propre accès PostgreSQL et l'administration de PgBouncer.
path "technique/data/donnees/cli_*" {
  capabilities = ["create", "update"]
}
path "technique/metadata/donnees/cli_*" {
  capabilities = ["read"]
}
path "technique/data/donnees/provisionneur" {
  capabilities = ["read"]
}
path "technique/data/donnees/pgbouncer-admin" {
  capabilities = ["read"]
}
