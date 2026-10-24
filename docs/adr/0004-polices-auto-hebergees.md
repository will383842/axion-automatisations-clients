# 0004 · Polices Fraunces et Manrope auto-hébergées

Date : 24/10/2026 · Statut : accepté

## Contexte
Charger des polices depuis le CDN de Google transmet l'adresse IP des visiteurs à un tiers, sans leur accord : problème de protection des données.

## Décision
Les polices Fraunces et Manrope sont AUTO-HÉBERGÉES via les paquets `@fontsource` (licence OFL). Jamais d'appel au CDN de Google ni à un autre CDN de polices.

## Conséquences
- Les fichiers de police sont servis par nos propres applications.
- Une garde de CI refusera toute référence à un CDN de polices externe.
- La licence OFL est à rappeler dans les mentions de licences.
