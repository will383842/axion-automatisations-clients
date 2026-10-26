# PostgreSQL du socle (T1A-03) avec pgBackRest (MIT) épinglé et le client SSH pour la clé d'essai. Ni téléchargement ni secret dans l'image.
FROM ghcr.io/will383842/axion-automatisations-clients/postgres-socle:16-r41@sha256:c5fd480db4b8537bfaf082b5b73cd6e288994309b4ac0bf8cc58694f6757e2ce
ARG PGBACKREST_VERSION=2.59.3-1.pgdg13+1
USER root
# Source d'archive PGDG : le dépôt principal ne garde que les dernières versions, l'archive les garde toutes (l'épinglage exact reste valable). Même clé que la source déjà présente (/usr/local/share/keyrings/postgres.gpg.asc).
RUN cle=/usr/local/share/keyrings/postgres.gpg.asc \
    && test -s "$cle" \
    && printf 'Types: deb\nURIs: https://apt-archive.postgresql.org/pub/repos/apt\nSuites: trixie-pgdg-archive\nComponents: main\nSigned-By: %s\n' "$cle" > /etc/apt/sources.list.d/pgdg-archive.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends "pgbackrest=${PGBACKREST_VERSION}" openssh-client \
    && rm -rf /var/lib/apt/lists/*
USER postgres
