# Essai A-210 : rôle fixe par base avec PgBouncer

Essai du test `[A-210]` (`tests/donnees/grappe.int.test.ts`), lu dans le journal du job `socle-integration` de la PR de T2-31.

## Montage
- 50 bases clients (`cli_<id>`), chacune avec son rôle d'application fixe, derrière le PgBouncer de la grappe données (mode transaction, `default_pool_size` 2, `max_db_connections` 2).
- 2 connexions client par base, soit 100 connexions, qui enchaînent `select 1` pendant 10 secondes.
- Machine : exécuteur GitHub jetable ; PostgreSQL et PgBouncer dans des conteneurs sur la même machine que le test.

## Résultat (une exécution)
- Débit : 9 454 requêtes par seconde.
- Latence vue par le client : médiane 8,3 ms, 95e centile 25,0 ms.
- Erreurs : 0 sur toute la durée ; les 100 connexions ont été servies.

## Limites de la mesure
- Une seule exécution, requête minimale : elle montre que le rôle fixe par base et deux connexions par base tiennent derrière PgBouncer, pas la charge d'un vrai client.
- Le test ne remesure pas à vide ni sans PgBouncer : aucun gain n'est annoncé.
- Un autre essai (`[A-236]`) montre le comportement au-delà de 250 connexions serveur.

Conclusion : validé (rôle fixe par base avec PgBouncer, 50 bases à 2 connexions).
