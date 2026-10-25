# Image dérivée temporaire (ADR 0015) : litellm-non_root au même tag, paquets Python vulnérables mis à jour. Retour à l'amont dès qu'il est vert.
FROM ghcr.io/berriai/litellm-non_root:main-v1.83.14-stable.patch.3@sha256:6da3c89855a0fd1c92258651e01b57f3d1ccb028afef0b4c62c9b89422dc2b77
USER root
COPY correctifs.txt /tmp/correctifs.txt
RUN python -m ensurepip && python -m pip install --no-cache-dir --no-deps --require-hashes -r /tmp/correctifs.txt && python -m pip check && python -c "import importlib.metadata as m; assert m.version('litellm') == '1.83.14'" && python -m pip uninstall -y pip && rm /tmp/correctifs.txt
USER nonroot
