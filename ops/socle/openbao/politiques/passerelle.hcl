# Seul rôle du conteneur de la passerelle : lire sa clé maîtresse et les clés des fournisseurs, rien d'autre.
path "passerelle/data/maitre" {
  capabilities = ["read"]
}
path "passerelle/data/fournisseurs" {
  capabilities = ["read"]
}
