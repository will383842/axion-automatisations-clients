# Stockage intégré (raft) sur le volume du conteneur. Écoute sur le réseau interne du socle seulement
# (aucun port publié) ; le TLS du coffre en production est traité par T1A-07.
storage "raft" {
  path    = "/openbao/file"
  node_id = "socle"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr = "http://openbao:8200"
cluster_addr = "http://openbao:8201"
ui = false

# Pas de verrouillage mémoire : la garde du compose interdit cap_add (IPC_LOCK) ; le stockage intégré n'écrit rien en clair sur le disque.
disable_mlock = true
