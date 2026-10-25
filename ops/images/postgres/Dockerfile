# PostgreSQL 16 avec pg_partman (paquet du dépôt apt de PostgreSQL, déjà configuré dans l'image officielle).
FROM postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97
ARG PARTMAN_VERSION=5.4.3-1.pgdg13+1
RUN apt-get update \
    && apt-get install -y --no-install-recommends "postgresql-16-partman=${PARTMAN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
# Sans gosu (binaire Go vulnérable, ADR 0014) : le conteneur démarre en utilisateur postgres, l'entrypoint n'appelle gosu que pour l'uid 0.
RUN rm /usr/local/bin/gosu
USER postgres
