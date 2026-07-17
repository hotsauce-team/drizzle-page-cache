-- drizzle-page-cache: Lua tag-purge transport for the nginx family
-- (lua-nginx-module — distro packages, OpenResty, or Angie's
-- angie-module-lua). No purge module and no resty.* libraries required.
--
-- Makes plain nginx tag-aware. The middleware stamps every cacheable
-- response with its tags (`Surrogate-Key: posts posts:3`); `log()` records
-- each cache key's tags (and the generation it was stored at) in a shared
-- dict whenever nginx stores a response. Purges enter through a dedicated
-- endpoint (`purge()`, mounted on its own guardable location — route shape
-- borrowed from Fastly's purging API, whose batch form is the same wire
-- format drizzle-page-cache's nginxPurger sends):
--
--   POST /__dpc/purge       Surrogate-Key: tag1 tag2    batch (the purger)
--   POST /__dpc/purge/<tag>                             single tag (curl)
--   POST /__dpc/purge_all                               flush everything
--
-- A purge may carry `X-DPC-Mark-TTL: <seconds>` — how long its marks are
-- remembered. The package's nginxPurger always sends its page
-- `ttl + staleWhileRevalidate`; headerless purges get MARK_TTL_CAP (30
-- days). The response echoes the applied value as `markTtl`.
--
-- (`PURGE` is accepted as a method alias; anything else gets 405. Mount
-- the location under any prefix — routing keys off the trailing segments.)
-- A purge marks each tag with a fresh generation; later requests whose
-- recorded tags carry a newer generation set $skip_cache=1,
-- `proxy_cache_bypass $skip_cache` fetches upstream (replacing the cached
-- entry), and `log()` re-records it.
--
-- Stale-proof by construction:
-- - a cache key the dicts don't know (first sight, a proxy restart with a
--   persistent cache, a dict eviction) is refreshed from upstream and
--   re-recorded — never trusted. That costs nothing over a native miss
--   (nginx would fetch upstream either way); only when a forgotten entry
--   really was cached does the one extra fetch buy back correctness. One
--   nuance: proxy_cache_lock does not coalesce these forced fetches the
--   way it coalesces native misses, so N concurrent FIRST requests to one
--   URL reach upstream N times, once;
-- - generations, not wall clock: the generation is captured in the rewrite
--   phase, so a purge landing while a refresh is in flight still wins
--   (its generation exceeds the re-recorded one) and same-tick purge +
--   refresh cannot tie;
-- - an unstorable response leaves the record untouched, so a purged URL
--   keeps bypassing rather than ever re-serving the stale entry.
-- Accepted race: concurrent requests to a purged URL each bypass until the
-- first refresh is recorded — bounded extra upstream fetches, never
-- staleness.
--
-- Cache-status reporting: nginx's $upstream_cache_status labels every
-- proxy_cache_bypass "BYPASS", but an unknown-key refresh IS a miss from
-- the client's view (fetched upstream, stored). `header_filter()` computes
-- the honest label into $dpc_cache_status — MISS for unknown keys, BYPASS
-- only for purge-driven refreshes, everything else passed through — and
-- the conf emits it with a plain add_header.
--
-- Required nginx configuration (see e2e/nginx/nginx.conf for a verified
-- config):
--
--   http {
--     # Tag -> generation purge marks. Eviction here would silently drop
--     # a purge record (stale until TTL), so size it generously. Marks
--     # self-size from the purge request's X-DPC-Mark-TTL header (the
--     # package's purger sends its ttl + staleWhileRevalidate); headerless
--     # purges are remembered for 30 days.
--     lua_shared_dict dpc_tags 4m;
--     # Cache key -> stored generation + tags. Eviction/expiry only costs
--     # an extra bypass, so LRU pressure is safe.
--     lua_shared_dict dpc_keys 16m;
--     lua_package_path "/path/to/this/dir/?.lua;;";
--
--     server {
--       # The purge API — the ONLY place purges can come from, so guard
--       # this one block: allow/deny, and/or a shared token (clients must
--       # then send a matching X-Purge-Token header).
--       location /__dpc/ {
--         # allow 172.16.0.0/12; deny all;
--         # set $dpc_purge_token "shared-secret";
--         content_by_lua_block { require("purge").purge() }
--       }
--
--       location / {
--         proxy_cache pub;
--         # MUST mirror cache_key() below or record/bypass misalign.
--         proxy_cache_key $uri$is_args$args;
--         set $skip_cache 0;
--         set $dpc_cache_status "";
--         rewrite_by_lua_block { require("purge").rewrite() }
--         proxy_cache_bypass $skip_cache;
--         header_filter_by_lua_block { require("purge").header_filter() }
--         log_by_lua_block { require("purge").log() }
--         add_header X-Cache-Status $dpc_cache_status;
--         proxy_pass http://upstream;
--       }
--     }
--   }
--
-- log() reads the tags from $upstream_http_surrogate_key, so
-- `proxy_hide_header Surrogate-Key` (recommended in production — tags leak
-- schema names) does not break it.

local M = {}

local GEN_KEY = "gen"
-- The purge-everything mark (set by /purge_all).
local ALL_KEY = "all"
-- Tag marks self-expire: a purge only matters for entries stored before
-- it, and no entry outlives its own s-maxage + stale-while-revalidate.
-- The purger states that lifetime per purge (`X-DPC-Mark-TTL`: its
-- `ttl + staleWhileRevalidate`), so the same app config that stamps page
-- freshness also sizes the marks that must outlive it — the two cannot
-- drift. Headerless purges (curl, ops tooling) fall back to the cap:
-- maximal safety, cheap because they are rare. High-volume clients other
-- than drizzle-page-cache's purger should send the header.
local MARK_TTL_CAP = 30 * 86400
local function mark_ttl()
  local h = tonumber(ngx.req.get_headers()["x-dpc-mark-ttl"])
  if h and h > 0 and h < MARK_TTL_CAP then return math.ceil(h) end
  return MARK_TTL_CAP
end
-- Safety margin on key records beyond the entry's own freshness lifetime.
local KEY_TTL_SLACK = 60

-- Tag marks share the dict with the generation counter — prefix them so a
-- table literally named "gen" (or "all") cannot clobber the counter.
local function tag_key(tag)
  return "t:" .. tag
end

-- Mirrors `proxy_cache_key $uri$is_args$args`.
local function cache_key()
  return ngx.var.uri .. ngx.var.is_args .. (ngx.var.args or "")
end

local function reply(status, body)
  ngx.status = status
  ngx.header["Content-Type"] = "application/json"
  ngx.say(body)
  return ngx.exit(status)
end

local function mark(tags_dict, dict_key, gen, ttl)
  local ok, err, forcible = tags_dict:set(dict_key, gen, ttl)
  if not ok then
    ngx.log(ngx.ERR, "dpc purge: mark set failed: ", err)
    return false
  end
  if forcible then
    ngx.log(
      ngx.ERR,
      "dpc purge: dpc_tags evicted an entry to fit ",
      dict_key,
      " — enlarge the dict, evicted purges can serve stale"
    )
  end
  return true
end

-- content phase: the purge API endpoint (see the header for the routes).
-- Mount on a dedicated location and restrict access there.
function M.purge()
  local method = ngx.req.get_method()
  if method ~= "POST" and method ~= "PURGE" then
    ngx.header["Allow"] = "POST, PURGE"
    return reply(
      ngx.HTTP_NOT_ALLOWED,
      '{"status":"error","error":"use POST (or PURGE)"}'
    )
  end
  -- Optional shared secret: `set $dpc_purge_token "..."` in the location.
  local token = ngx.var.dpc_purge_token
  if token and token ~= "" then
    if ngx.req.get_headers()["x-purge-token"] ~= token then
      return reply(
        ngx.HTTP_FORBIDDEN,
        '{"status":"error","error":"bad or missing X-Purge-Token"}'
      )
    end
  end

  local uri = ngx.var.uri
  local tags = {}
  local all = false
  local single = uri:match("/purge/(.+)$")
  if single then
    tags[1] = ngx.unescape_uri(single)
  elseif uri:find("/purge_all$") then
    all = true
  elseif uri:find("/purge$") then
    local h = ngx.req.get_headers()["surrogate-key"]
    if type(h) == "table" then h = table.concat(h, " ") end
    -- Strictly space-separated (the Fastly shape). A comma means the client
    -- speaks another dialect (e.g. Souin's) — reject rather than mis-purge.
    if (h or ""):find(",", 1, true) then
      return reply(
        ngx.HTTP_BAD_REQUEST,
        '{"status":"error","error":"comma in Surrogate-Key — tags are space-separated (Fastly-shaped)"}'
      )
    end
    for tag in (h or ""):gmatch("%S+") do
      tags[#tags + 1] = tag
    end
    if #tags == 0 then
      return reply(
        ngx.HTTP_BAD_REQUEST,
        '{"status":"error","error":"missing Surrogate-Key header"}'
      )
    end
  else
    return reply(
      ngx.HTTP_NOT_FOUND,
      '{"status":"error","error":"unknown purge route"}'
    )
  end

  local tags_dict = ngx.shared.dpc_tags
  local gen, err = tags_dict:incr(GEN_KEY, 1, 0)
  if not gen then
    ngx.log(ngx.ERR, "dpc purge: generation incr failed: ", err)
    return reply(
      ngx.HTTP_INTERNAL_SERVER_ERROR,
      '{"status":"error","error":"generation incr failed"}'
    )
  end
  local ttl = mark_ttl()
  local failed = false
  if all then
    failed = not mark(tags_dict, ALL_KEY, gen, ttl)
  else
    for _, tag in ipairs(tags) do
      if not mark(tags_dict, tag_key(tag), gen, ttl) then failed = true end
    end
  end
  if failed then
    return reply(
      ngx.HTTP_INTERNAL_SERVER_ERROR,
      '{"status":"error","error":"mark set failed"}'
    )
  end
  -- markTtl echoes the applied lifetime so headerless callers can see
  -- what they got (and tests can assert both branches without waiting).
  return reply(
    ngx.HTTP_OK,
    all and ('{"status":"ok","purged":"all","markTtl":' .. ttl .. "}")
      or ('{"status":"ok","purged":' .. #tags .. ',"markTtl":' .. ttl .. "}")
  )
end

-- rewrite phase: decide whether to bypass the cache for this request.
function M.rewrite()
  local tags_dict = ngx.shared.dpc_tags
  local key = cache_key()
  -- Capture the generation BEFORE any upstream fetch: a purge landing
  -- mid-flight gets a higher one and beats the record log() writes.
  ngx.ctx.dpc_key = key
  ngx.ctx.dpc_gen = tags_dict:get(GEN_KEY) or 0

  local rec = ngx.shared.dpc_keys:get(key)
  if rec == nil then
    -- Unknown key: nginx may hold an entry recorded before a restart /
    -- dict eviction whose tags we no longer know — refresh it. To the
    -- client this is a miss (header_filter() reports it as one).
    ngx.var.skip_cache = 1
    ngx.ctx.dpc_unknown = true
    return
  end
  local sep = rec:find("|", 1, true)
  local stored_gen = sep and tonumber(rec:sub(1, sep - 1))
  if not stored_gen then -- corrupt record: treat as unknown
    ngx.var.skip_cache = 1
    ngx.ctx.dpc_unknown = true
    return
  end
  local g = tags_dict:get(ALL_KEY)
  if g and g > stored_gen then
    ngx.var.skip_cache = 1
    return
  end
  for tag in rec:sub(sep + 1):gmatch("%S+") do
    g = tags_dict:get(tag_key(tag))
    if g and g > stored_gen then
      ngx.var.skip_cache = 1
      return
    end
  end
end

-- header filter phase: publish the client-visible cache status into
-- $dpc_cache_status (declared with `set` in the conf, emitted with
-- add_header). An unknown-key refresh reads MISS — which it is — leaving
-- BYPASS to mean exactly "a purge evicted this".
function M.header_filter()
  local status = ngx.var.upstream_cache_status
  if not status or status == "" then return end
  if status == "BYPASS" and ngx.ctx.dpc_unknown then
    status = "MISS"
  end
  ngx.var.dpc_cache_status = status
end

-- log phase: whenever nginx stored a fresh copy, record its tags and the
-- rewrite-phase generation so future requests can check it for purges.
function M.log()
  local key = ngx.ctx.dpc_key
  if not key then return end
  local status = ngx.var.upstream_cache_status
  if status ~= "BYPASS" and status ~= "MISS" and status ~= "EXPIRED" then
    return
  end
  -- Record only what nginx stored. Without proxy_cache_valid, freshness
  -- comes from the response itself — no lifetime, or an uncacheable
  -- directive, means nothing was stored (and a purged entry keeps
  -- bypassing rather than ever serving stale).
  local cc = ngx.var.upstream_http_cache_control or ""
  if
    cc:find("no-store", 1, true)
    or cc:find("no-cache", 1, true)
    or cc:find("private", 1, true)
  then
    return
  end
  local smax = tonumber(cc:match("s%-maxage=(%d+)"))
    or tonumber(cc:match("max%-age=(%d+)"))
  if not smax or smax == 0 then return end
  local swr = tonumber(cc:match("stale%-while%-revalidate=(%d+)")) or 0
  -- Strictly space-separated (the Fastly shape). A comma here means the app
  -- speaks another dialect, or sent repeated Surrogate-Key headers (nginx
  -- >= 1.23 joins those with ", "). Recording it verbatim would store tags
  -- like "posts:3," that no purge matches — silent staleness. Refuse the
  -- record instead: the entry stays an unknown key (refreshed every
  -- request — safe, visible), and the warning names the fix.
  local raw = ngx.var.upstream_http_surrogate_key or ""
  if raw:find(",", 1, true) then
    ngx.log(
      ngx.WARN,
      "dpc purge: comma in upstream Surrogate-Key (dialect is ",
      "space-separated; send ONE space-joined header) — not recording, ",
      "entry will refresh on every request: ",
      key
    )
    return
  end
  local val = ngx.ctx.dpc_gen .. "|" .. raw
  -- Eviction here is benign: a recordless entry is refreshed on its next
  -- request (see rewrite()).
  local ok, err = ngx.shared.dpc_keys:set(key, val, smax + swr + KEY_TTL_SLACK)
  if not ok then
    ngx.log(ngx.WARN, "dpc purge: key record set failed: ", err)
  end
end

return M
