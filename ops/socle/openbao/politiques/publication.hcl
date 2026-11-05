# Signature de production des modules (T4-26) : signer avec la seule clé modules-publication.
# Aucune lecture de valeur, aucune autre clé, aucune configuration de clé (donc aucun export), aucun joker.
path "transit/sign/modules-publication" {
  capabilities = ["update"]
}
