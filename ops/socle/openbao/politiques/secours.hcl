# Copie de secours (A-303), utilisée à la main : instantané raft de tout OpenBao, chiffré par la barrière. Aucune écriture, aucune signature (ADR 0017).
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
