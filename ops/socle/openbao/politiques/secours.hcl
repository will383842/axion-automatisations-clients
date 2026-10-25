# Copie de secours (A-303), utilisée à la main : le paquet de la clé de signature et la lecture des clés HMAC. Aucune écriture, aucune signature.
path "transit/backup/modules-signature" {
  capabilities = ["read"]
}
path "transit/keys/modules-signature" {
  capabilities = ["read"]
}
path "technique/data/echanges/*" {
  capabilities = ["read"]
}
path "technique/metadata/echanges/*" {
  capabilities = ["list"]
}
