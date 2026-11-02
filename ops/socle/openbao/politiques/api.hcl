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
# Empreinte de recherche (T2-33) : HMAC par la clé cli-<id>-recherche du client. Vault n'a pas de joker au milieu d'un segment : le préfixe cli-* couvre aussi
# la clé de chiffrement cli-<id> (écart à la fiche, consigné dans spec/preuves.md : LOT2-dette-T2-33-hmac-prefixe).
path "transit/hmac/cli-*" {
  capabilities = ["update"]
}
# Service des données (T2-37c) : l'API lit les mots de passe app et lecture d'un client pour ouvrir sa connexion par PgBouncer « données ». Lecture seule, aucune liste ;
# jamais le propriétaire, le provisionneur ni l'administration de PgBouncer. Le joker * n'est valable qu'en dernier caractère : le segment du client est un « + ».
path "technique/data/donnees/+/app" {
  capabilities = ["read"]
}
path "technique/data/donnees/+/lecture" {
  capabilities = ["read"]
}
