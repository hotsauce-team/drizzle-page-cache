#!/bin/sh
# Regenerate caddy.json from the Caddyfile, then patch what the Caddyfile
# cannot express:
#  1. Souin API enable on every cache handler — the plugin's FromApp never
#     copies the global `api` block into handler configs (see SPEC.md
#     "Upstream issues"), so a Caddyfile-only setup can't enable it.
#  2. TLS session tickets disabled — full handshakes for the TLS bench.
# Requires the caddy-cache:local image (docker compose build caddy).
set -eu
cd "$(dirname "$0")"

docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  --entrypoint caddy caddy-cache:local \
  adapt --config /etc/caddy/Caddyfile > caddy.raw.json

deno eval '
  const j = JSON.parse(Deno.readTextFileSync("caddy.raw.json"));
  let patched = 0;
  for (const srv of Object.values(j.apps.http.servers) as any[]) {
    for (const route of srv.routes ?? []) {
      for (const h of route.handle ?? []) {
        if (h.handler === "cache" && h.Configuration?.API?.souin) {
          h.Configuration.API.souin.enable = true;
          patched++;
        }
      }
    }
  }
  j.apps.tls = { ...(j.apps.tls ?? {}), session_tickets: { disabled: true } };
  Deno.writeTextFileSync("caddy.json", JSON.stringify(j, null, 2) + "\n");
  console.log(`caddy.json written (${patched} cache handlers patched, tickets disabled)`);
'
rm -f caddy.raw.json
