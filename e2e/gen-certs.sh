#!/bin/sh
# Generate the shared self-signed ECDSA P-256 cert used by every proxy's TLS
# listener (parity: same key type everywhere — RSA handshakes are ~10× more
# expensive and would swamp the comparison). Output is gitignored.
set -eu
cd "$(dirname "$0")"
mkdir -p certs
docker run --rm -v "$PWD/certs:/certs" alpine/openssl req -x509 \
  -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout /certs/key.pem -out /certs/cert.pem \
  -days 365 -subj "/CN=bench.local"
docker run --rm -v "$PWD/certs:/certs" alpine/openssl sh -c \
  "chmod 644 /certs/key.pem /certs/cert.pem" 2>/dev/null ||
  docker run --rm -v "$PWD/certs:/certs" --entrypoint sh alpine/openssl -c \
    "chmod 644 /certs/key.pem /certs/cert.pem"
echo "certs/cert.pem + certs/key.pem generated"
