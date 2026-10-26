# @axion-auto/executeur

Noyau de l'exécuteur, entièrement en mémoire (T4-02).
Il tourne sans service ni conteneur : tout passe par les ports de `src/noyau/ports.ts`.
Le lot 4B branche PostgreSQL, BullMQ et HTTP sur ces ports, sans réécrire le noyau.

- `machine.ts` : exécution rejouable, étape par étape.
- `intention.ts` : clé anti-doublon dérivée et règle des trois garanties.
- `politique-erreurs.ts` : les quatre classes d'erreur de C4.
- `memoire/` : une version en mémoire de chaque port, pour les tests.

Les manques trouvés dans le contrat C4 sont dans `docs/c4-manques-du-prototype.md`.
