# Image dérivée temporaire (ADR 0014) : postgres officielle sans gosu (binaire Go vulnérable). Retour à l'amont dès qu'il est vert.
FROM postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
RUN rm /usr/local/bin/gosu /usr/local/bin/su-exec
USER postgres
