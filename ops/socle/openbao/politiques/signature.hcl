# Signature des modules (A-193) : signer, vérifier, lire l'état public de la clé. Ni copie, ni export, ni création.
path "transit/sign/modules-signature" {
  capabilities = ["update"]
}
path "transit/verify/modules-signature" {
  capabilities = ["update"]
}
path "transit/keys/modules-signature" {
  capabilities = ["read"]
}
