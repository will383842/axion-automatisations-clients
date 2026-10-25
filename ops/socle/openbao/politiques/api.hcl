# L'API range et remplace des identifiants, lit leurs métadonnées, mais ne relit jamais une valeur.
path "clients/data/*" {
  capabilities = ["create", "update"]
}
path "clients/metadata/*" {
  capabilities = ["create", "update", "read"]
}
path "transit/keys/cli-*" {
  capabilities = ["create", "update", "delete"]
}
path "transit/datakey/plaintext/cli-*" {
  capabilities = ["update"]
}
path "transit/decrypt/cli-*" {
  capabilities = ["update"]
}
