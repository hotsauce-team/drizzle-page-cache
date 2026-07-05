vcl 4.1;

# Bench pairing: Varnish caches what the app's Cache-Control says (s-maxage
# drives freshness; no-store responses become hit-for-miss automatically via
# builtin VCL). TLS is terminated by hitch (PROXY protocol on :8443).

backend default {
  .host = "app";
  .port = "8000";
}

sub vcl_deliver {
  # Integrate with the harness's cache-state greps.
  if (obj.hits > 0) {
    set resp.http.X-Cache-Status = "HIT";
  } else {
    set resp.http.X-Cache-Status = "MISS";
  }
}
