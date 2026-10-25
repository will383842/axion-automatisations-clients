# L'équipe voit l'état d'un identifiant (métadonnées), jamais sa valeur.
path "clients/metadata/*" {
  capabilities = ["read"]
}
