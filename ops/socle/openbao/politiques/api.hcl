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
# Service des données (T2-37c) : l'API lit le seul mot de passe « lecture » d'un client pour ouvrir sa connexion par PgBouncer « données ». Moindre privilège :
# le service ne sert que des requêtes en lecture (l'écriture déclarée est refusée au chargement), donc le mot de passe « app » n'est PAS lisible ; il ne sera ajouté
# qu'avec l'écriture déclarée, par une fiche et un test. Lecture seule, aucune liste, aucun accès à /metadata ; jamais le propriétaire, le provisionneur ni
# l'administration de PgBouncer. Le joker * n'est valable qu'en dernier caractère : le segment du client est un « + ». Un essai fige la liste entière des droits.
path "technique/data/donnees/+/lecture" {
  capabilities = ["read"]
}
# Export signé (T2-42b) : l'API fait signer le manifeste par la clé exports-signature (Ed25519, non exportable). Signer seulement : ni lecture de la clé, ni vérification,
# ni création, aucun joker.
path "transit/sign/exports-signature" {
  capabilities = ["update"]
}
