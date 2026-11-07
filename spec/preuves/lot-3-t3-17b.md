# T3-17b : outils du client et compatibilité (lecture seule)

Exigences : A-408, A-409, A-410, C-200, B-126, C-536.

## Fait
- `apps/api/src/compatibilite/calcul.ts` : fonction pure qui classe chaque automatisation du catalogue en compatible, à créer ou impossible, avec une raison en code fermé, la fiche de connexion (familles demandées et outils compatibles du catalogue) et la gamme conseillée (null si aucun port ne la donne).
- `apps/api/src/compatibilite/depot.ts` : trois requêtes constantes sous `console_equipe`, colonnes nommées, `tenant_id = $1` sur les outils ; les familles du manifeste sont extraites dans SQL (`jsonb_path_query_array`), le manifeste entier n'est jamais lu.
- `GET /api/console/v1/clients/:id/outils` : réservée à l'équipe, action `lire`, client hors portée = 404 sans lecture, porte fermée = 503, identifiant non UUID = 400.

## Tests
- Rouges d'abord (commit séparé), puis verts : calcul, dépôt, route, `tests/mauvais-client/outils.test.ts`.
- Essai réel `[A-409]` ajouté à la fin de `apps/api/src/db/suivi.int.test.ts` : non joué ici (pas de Docker), à juger par `socle-integration`.

## Limites
- La gamme conseillée reste null tant que T3-32 ne fournit pas l'adaptateur du port `gammeConseillee`.
- Le catalogue des connecteurs fait foi ; `outils_client.connecteur_disponible` est ignoré.
