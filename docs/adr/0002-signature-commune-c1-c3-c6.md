# 0002 · Signature commune de C1, C3 et C6

Date : 24/10/2026 · Statut : accepté

## Contexte
Les canaux signés entre la console, le Hub et le CRM (C1, C3) et le lien de connexion de l'équipe (C6) doivent partager une même règle de signature, pour éviter trois variantes à auditer. Un piège déjà rencontré : un séparateur qui peut apparaître dans les champs signés rend la découpe ambiguë.

## Décision
- Signature HMAC-SHA256, un secret PAR SENS.
- En-têtes HTTP pour C1 et C3 uniquement : `X-Axion-Cle` (identifiant de clé), `X-Axion-Horodatage` (secondes Unix, exactement 10 chiffres), `X-Axion-Signature: v1=<hex>`.
- C6 n'est pas une requête HTTP : il n'a pas d'en-têtes ; sa signature est portée dans le lien lui-même (voir l'annexe A du dépôt privé). Il partage seulement l'algorithme (HMAC-SHA256, un secret par sens) et la règle de séparateur non ambigu.
- Chaîne signée : `v1\n<horodatage>\n<MÉTHODE>\n<chemin + requête, tels qu'envoyés>\n<sha256 hex du corps brut>`. Méthode et chemin sont signés : un corps rejoué vers une autre route est refusé. Le séparateur \n ne peut apparaître ni dans l'horodatage, ni dans la méthode, ni dans un chemin d'URL : la découpe est non ambiguë.
- Fenêtre de ±300 s ; au-delà : 401 `horodatage_perime`.
- Anti-rejeu : couple (clé, signature) mémorisé 10 minutes ; revu : 401 `rejeu`.
- 2 clés actives par sens, chevauchement de 24 h, rotation tous les 6 mois ; clés dans le coffre de l'exploitation, jamais dans un dépôt.
- Écritures C1 et C3 : `Idempotency-Key` obligatoire ; même clé et même corps → même réponse (`Idempotency-Replayed: true`) ; même clé et corps différent → 409 `cle_reutilisee`.
- Porte fermée par défaut : 503 `porte_fermee`.

## Conséquences
- Une seule implémentation de signature et de vérification dans `packages/contrats`, testée une fois.
- Tout changement de cette règle exige un nouvel ADR et l'accord de l'architecte.
- Le texte complet des contrats est dans le dépôt privé (annexe A).
