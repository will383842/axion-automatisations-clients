# Provisionnement des bases des clients (T2-34), jeton du seul dossier apps/api/src/provisionnement : range les mots de passe d'un client sans les relire ; lit son accès PostgreSQL et l'administration de PgBouncer.
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
