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
# Réenveloppement après rotation (T2-53) : la clé de données est rechiffrée sous la version courante, sans jamais rendre le clair.
path "transit/rewrap/cli-*" {
  capabilities = ["update"]
}
# Empreinte de recherche (T2-33) : HMAC par la clé cli-<id>-recherche du client. Vault n'a pas de joker au milieu d'un segment : le préfixe cli-* couvre aussi
# la clé de chiffrement cli-<id> (écart à la fiche, consigné dans spec/preuves.md : LOT2-dette-T2-33-hmac-prefixe).
path "transit/hmac/cli-*" {
  capabilities = ["update"]
}
