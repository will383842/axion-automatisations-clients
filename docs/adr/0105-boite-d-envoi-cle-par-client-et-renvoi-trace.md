# 0105 · Boîte d'envoi : clé par client, renvoi tracé

Date : 02/11/2026 · Statut : proposé (T2-14, aucune migration) · Contrat touché : aucun

## Décision
1. **La clé d'envoi dépend du client.** `deposer` la dérive de la destination et de `JSON.stringify([client, intention])`, le client étant lu dans la transaction. Deux clients de même intention n'ont plus la même Idempotency-Key ni le même jobId de la file.
2. **Le renvoi d'un échec est un acte d'une personne.** `Magasin.renvoyer` exige un appelant valide (`verifierAppelant`), écrit une ligne au journal d'audit (`modification` de `boite_envoi`, action `renvoi`, ligne, acteur) dans la même transaction, et refuse une ligne créée il y a plus de `CONSERVATION_IDEMPOTENCE_JOURS` jours sauf `confirmerAnciennete: true`, car le Hub a alors oublié la clé.
3. **Dépôt resserré** : méthode égale à celle du contrat, paramètres de chemin en `[A-Za-z0-9_-]+`, statut et clôture rapprochés du client de la transaction.
4. **Essais** : l'horodatage suit `horodatageSuivant` (ADR 0033) ; la réponse du Hub est bornée à 64 Kio avant le stockage.

## Dettes
Écrites avec propriétaire et critère de test dans `spec/preuves.md` : `LOT2-dette-T2-14-echecs`, `-idempotency-key`, `-axicli`.
