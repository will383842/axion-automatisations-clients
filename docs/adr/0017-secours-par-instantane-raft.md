# ADR 0017 — Copie de secours d'OpenBao par instantané raft

## Contexte
OpenBao refuse `transit/backup` pour une clé non exportable (« exporting is disallowed on the policy »), et `allow_plaintext_backup` n'y change rien. Or `[A-193]` (clé de signature des modules non exportable) et `[A-303]` (copie de secours restaurable) sont toutes deux exigées.

## Décision
- `modules-signature` est créée en `ed25519`, `exportable=false`, sans `allow_plaintext_backup`.
- Le secours est un instantané raft de tout OpenBao, lu par la seule politique `secours` (`sys/storage/raft/snapshot`, `read`). L'application ne touche jamais au secours.
- La restauration se fait dans un OpenBao neuf (`sys/storage/raft/snapshot-force`), puis on le déverrouille avec les parts Shamir d'origine.
- Si le vrai OpenBao exige `sudo` sur ce chemin, il sera ajouté sur ce seul chemin et dit ici : aucun autre `sudo`.

## Conséquences
- L'instantané est chiffré par la barrière d'OpenBao : sans le quorum Shamir (3 parts sur 5), il est inutilisable. La clé privée ne sort jamais en clair.
- Les parts Shamir ne sont jamais rangées avec l'instantané (la procédure de secours le dira).
- L'instantané couvre aussi les clés HMAC de `technique/`.
- La politique `secours` est la seule exception, nommée, à « aucun chemin `sys/` ».
- Rendre la clé exportable ou élargir une politique demande déjà l'accès en écriture au dépôt (`initialiser.sh`, `politiques/`) : ce contournement n'est pas traité ici.

2026-10-25
