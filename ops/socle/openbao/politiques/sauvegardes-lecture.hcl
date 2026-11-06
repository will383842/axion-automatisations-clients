# Tâche de sauvegarde (C-523, C-593) : lire la phrase de chiffrement, rien d'autre.
# Ni écriture, ni liste, ni autre chemin. Le jeton est propre à cette tâche (jamais le jeton racine) et vit dans un fichier (BAO_JETON_FICHIER).
path "technique/data/sauvegardes" {
  capabilities = ["read"]
}
