// k6 load script for the local bench harness (see ../bench.sh).
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL;
const PATH = __ENV.TARGET_PATH || "/post/3";

export const options = {
  vus: Number(__ENV.VUS || 8),
  duration: __ENV.DURATION || "30s",
  // Handshake-stress mode: every request opens a fresh connection (full TLS
  // handshake — servers have session resumption disabled).
  noConnectionReuse: __ENV.NO_REUSE === "1",
  insecureSkipTLSVerify: true, // self-signed bench cert
};

export default function () {
  const res = http.get(`${BASE}${PATH}`);
  check(res, { "status 200": (r) => r.status === 200 });
}
