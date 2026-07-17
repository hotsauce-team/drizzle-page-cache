vcl 4.1;

# Verify + bench pairing: Varnish caches what the app's Cache-Control says
# (s-maxage drives freshness; no-store responses become hit-for-miss
# automatically via builtin VCL), indexes objects by the tags in the app's
# `xkey` response header (vmod-xkey does that on import), and purges them on
# PURGE requests from the xkey dialect. TLS is terminated by hitch (PROXY
# protocol on :8443).

import xkey;

backend default {
  .host = "app-varnish";
  .port = "8000";
}

# Varnish applies no auth to PURGE — restrict it to the compose network.
acl purge_allow {
  "localhost";
  "10.0.0.0"/8;
  "172.16.0.0"/12;
  "192.168.0.0"/16;
}

sub vcl_recv {
  if (req.method == "PURGE") {
    if (client.ip !~ purge_allow) {
      return (synth(403, "Forbidden"));
    }
    # Hard purge: the dialect emits stale-while-revalidate, which Varnish
    # maps to grace — xkey.softpurge would keep serving the stale body as a
    # HIT and the write -> fresh-MISS loop would never be observable.
    set req.http.n-purged = xkey.purge(req.http.xkey);
    return (synth(200, "Purged " + req.http.n-purged));
  }
}

sub vcl_deliver {
  # Integrate with the harness's cache-state greps.
  if (obj.hits > 0) {
    set resp.http.X-Cache-Status = "HIT";
  } else {
    set resp.http.X-Cache-Status = "MISS";
  }
  # The tags carry schema names and row IDs, and vmod-xkey does not remove
  # the header — strip it before clients see it. vcl_deliver runs after the
  # object was indexed in vcl_backend_response, so purging is unaffected.
  unset resp.http.xkey;
}
