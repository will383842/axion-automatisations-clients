# ADR 0025 — Bac à sable d'exécution : un processus jetable par exécution

## Contexte
En mode mutualisé, des clients différents tournent sur la même cellule (T4-19, A-328 à A-330). Le modèle de permissions de Node 22 interdit la lecture hors liste, l'écriture, les processus et les workers, mais n'a PAS de permission réseau (elle n'existe qu'à partir d'une version plus récente).

## Décision
- Une exécution = un `child_process.fork` de `bac-a-sable/enfant.mjs`, lancé avec `--experimental-permission`, lecture limitée à ce seul fichier, `--max-old-space-size` et `--disallow-code-generation-from-strings`.
- Environnement de l'enfant : `AXION_EXECUTION_ID` seulement. Le jeton court du courtier passe par le canal.
- Le parent vérifie la signature (T4-07) puis envoie le module en base64 par le canal : l'enfant ne lit jamais le disque.
- Canal : messages JSON typés, validés des deux côtés (`canal.ts`).
- L'enfant est tué (SIGKILL) à la fin et à la durée limite ; le résultat n'est rendu qu'une fois le processus parti. Jamais réutilisé.
- Réseau : l'amorce retire `net.Socket.connect`, `dgram` et `dns` avant d'évaluer le module. C'est une défense en profondeur, PAS la frontière : celle-ci est le réseau de l'image et le mandataire de sortie (étape 2 de T4-19).
- Interrupteur fermé par défaut : `executerEnBac` refuse (`bac_ferme`) tant que `actif` n'est pas vrai ; le branchement sur une variable est laissé à l'assemblage.

## Conséquences
- La version de Node de l'image doit rester épinglée : chaque interdiction est testée (`bac-a-sable.test.ts`), un changement de version fait rougir les tests.
- Les attaques `WebAssembly` et `Atomics` ne donnent ni fichier ni réseau ; l'audit les rejouera.
- Sans l'étape 2, un module hostile pourrait encore atteindre le réseau par un chemin non listé : l'interrupteur reste fermé jusque-là.

Date : 2026-10-26.
