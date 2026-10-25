# Clés HMAC des échanges (C-015) : l'API seule, sous technique/echanges. Ni le courtier ni l'équipe.
path "technique/data/echanges/*" {
  capabilities = ["create", "update", "read"]
}
path "technique/metadata/echanges/*" {
  capabilities = ["list"]
}
