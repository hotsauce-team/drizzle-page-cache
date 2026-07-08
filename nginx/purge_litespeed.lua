-- drizzle-page-cache: LiteSpeed-dialect tag cache for the nginx family
-- (lua-nginx-module — distro packages, OpenResty, or Angie's
-- angie-module-lua). The sibling of purge.lua, speaking LSCache instead
-- of Surrogate-Key: it understands the response headers the LiteSpeed
-- Cache engine understands, so apps written for LiteSpeed — including
-- WordPress with the LiteSpeed Cache plugin (LSCWP), and this package's
-- own `drizzle-page-cache/litespeed` entrypoint — can run behind plain
-- nginx unchanged:
--
--   X-LiteSpeed-Cache-Control: public,max-age=3600   cacheability + TTL
--   X-LiteSpeed-Tag: tag1,tag2                       tags the cache key
--   X-LiteSpeed-Purge: tag=a, tag=b | * | url=/path  purge, riding ANY
--                                                    response THROUGH the
--                                                    proxy (LiteSpeed has
--                                                    no PURGE verb)
--
-- Mechanics are purge.lua's: `log()` records each cache key's tags and a
-- generation in shared dicts when nginx stores a response;
-- `header_filter()` executes X-LiteSpeed-Purge headers by marking tags
-- (or URLs, or everything) with a fresh generation; requests whose
-- recorded tags carry a newer generation set $skip_cache=1 and
-- `proxy_cache_bypass` refetches. Unknown keys are refreshed, never
-- trusted; generations are captured in the rewrite phase so mid-flight
-- purges always win; the client-visible status is published honestly
-- into $dpc_cache_status (plus an `X-LiteSpeed-Cache: hit|miss` header
-- for tooling that checks it).
--
-- Freshness needs one nginx-side trick: nginx cannot read
-- X-LiteSpeed-Cache-Control natively (WordPress typically sends
-- `Cache-Control: no-cache` alongside it, which would forbid storing), so
-- the conf ignores the browser-facing headers and stores for a fixed
-- ceiling; the REAL per-page max-age is enforced here — the key record
-- expires with the page's max-age, and an expired record forces a
-- refresh. Required nginx configuration:
--
--   http {
--     lua_shared_dict dpc_tags 4m;
--     lua_shared_dict dpc_keys 16m;
--     lua_package_path "/path/to/this/dir/?.lua;;";
--     # Store ONLY what X-LiteSpeed-Cache-Control marks public (and never
--     # ESI responses — nginx cannot assemble them; keep ESI off in LSCWP).
--     map $upstream_http_x_litespeed_cache_control $dpc_ls_nostore {
--       default 1;
--       "~*(no-cache|no-store|private|esi=on)" 1;
--       "~*public" 0;
--     }
--
--     server {
--       location / {
--         proxy_cache pub;
--         proxy_cache_key $uri$is_args$args;   # MUST mirror cache_key()
--         proxy_ignore_headers Cache-Control Expires;
--         proxy_cache_valid 200 301 302 8d;    # ceiling only, see above
--         set $skip_cache 0;
--         set $dpc_cache_status "";
--         rewrite_by_lua_block { require("purge_litespeed").rewrite() }
--         # _lscache_vary is the cookie LSCWP sets for logged-in users:
--         # they must never be served from (or stored into) public cache.
--         proxy_cache_bypass $skip_cache $cookie__lscache_vary;
--         proxy_no_cache $dpc_ls_nostore $cookie__lscache_vary;
--         header_filter_by_lua_block {
--           require("purge_litespeed").header_filter()
--         }
--         log_by_lua_block { require("purge_litespeed").log() }
--         add_header X-Cache-Status $dpc_cache_status;
--         # LiteSpeed strips its control headers; do the same. log() and
--         # header_filter() read the $upstream_http_* copies, which
--         # proxy_hide_header does not touch.
--         proxy_hide_header X-LiteSpeed-Cache-Control;
--         proxy_hide_header X-LiteSpeed-Tag;
--         proxy_hide_header X-LiteSpeed-Purge;
--         proxy_pass http://upstream;
--       }
--     }
--   }
--
-- Scope honesty vs a real LiteSpeed server: PUBLIC page cache only. No
-- private/per-user cache (private purges are ignored — there is nothing
-- to purge), no ESI assembly, no vary beyond the logged-in-cookie bypass
-- above, no crawler. For LSCWP that means: ESI off, Object/Browser cache
-- as you like (they don't involve the proxy), guest mode fine.

local M = {}

local GEN_KEY = "gen"
-- Purge marks must outlive any entry stored before them. LSCWP's default
-- public TTL is 604800 (a week) — raise this if you raise that.
local TAG_TTL = 8 * 86400
-- X-LiteSpeed-Cache-Control said public but carried no max-age.
local DEFAULT_TTL = 3600

-- Mark namespaces inside dpc_tags (so nothing collides with GEN_KEY):
-- tags, exact-URL purges, and the purge-everything mark.
local function tag_key(tag)
  return "t:" .. tag
end
local function url_mark_key(url)
  return "u:" .. url
end
local ALL_KEY = "all"

-- Mirrors `proxy_cache_key $uri$is_args$args`.
local function cache_key()
  return ngx.var.uri .. ngx.var.is_args .. (ngx.var.args or "")
end

local function mark(tags_dict, key, gen)
  local ok, err, forcible = tags_dict:set(key, gen, TAG_TTL)
  if not ok then
    ngx.log(ngx.ERR, "dpc ls-purge: mark set failed: ", err)
  elseif forcible then
    ngx.log(
      ngx.ERR,
      "dpc ls-purge: dpc_tags evicted an entry to fit ",
      key,
      " — enlarge the dict, evicted purges can serve stale"
    )
  end
end

-- Execute one X-LiteSpeed-Purge value. Syntax (LSCache devguide):
-- `;`-separated scope blocks of `,`-separated items; `public` / `private`
-- / `stale` are attributes, items are `tag=name`, `url=/path`, or `*`.
-- Private blocks are skipped — this cache holds no private copies.
local function do_purge(tags_dict, value)
  local gen -- allocated lazily: attribute-only / private-only values are no-ops
  for block in value:gmatch("[^;]+") do
    local private = false
    local items = {}
    for raw in block:gmatch("[^,]+") do
      local item = raw:match("^%s*(.-)%s*$")
      local low = item:lower()
      if low == "private" then
        private = true
      elseif low == "public" or low == "stale" or item == "" then
        -- public is the default scope; stale-marking degrades to a normal
        -- purge here (refresh on next request).
      else
        items[#items + 1] = item
      end
    end
    if not private then
      for _, item in ipairs(items) do
        if not gen then
          local err
          gen, err = tags_dict:incr(GEN_KEY, 1, 0)
          if not gen then
            ngx.log(ngx.ERR, "dpc ls-purge: generation incr failed: ", err)
            return
          end
        end
        local low = item:lower()
        if item == "*" then
          mark(tags_dict, ALL_KEY, gen)
        elseif low:sub(1, 4) == "tag=" then
          -- `public:` on a tag name is scope decoration — strip it.
          local tag = item:sub(5):gsub("^public:", "")
          mark(tags_dict, tag_key(tag), gen)
        elseif low:sub(1, 4) == "url=" then
          mark(tags_dict, url_mark_key(item:sub(5)), gen)
        else
          -- Tolerate bare tag names some integrations emit.
          mark(tags_dict, tag_key(item), gen)
        end
      end
    end
  end
end

-- rewrite phase: decide whether to bypass (LiteSpeed has no PURGE verb —
-- purges arrive on response headers, handled in header_filter()).
function M.rewrite()
  local tags_dict = ngx.shared.dpc_tags
  local key = cache_key()
  -- Capture the generation BEFORE any upstream fetch: a purge landing
  -- mid-flight gets a higher one and beats the record log() writes.
  ngx.ctx.dpc_key = key
  ngx.ctx.dpc_gen = tags_dict:get(GEN_KEY) or 0

  local rec = ngx.shared.dpc_keys:get(key)
  if rec == nil then
    -- Unknown key: refresh, never trust (also how per-page max-age is
    -- enforced — records expire with the page's freshness). To the client
    -- this is a miss; header_filter() reports it as one.
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
  g = tags_dict:get(url_mark_key(key))
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

-- header filter phase: execute purges riding this response, then publish
-- the client-visible cache status (see purge.lua — unknown-key refreshes
-- read MISS; BYPASS means exactly "a purge evicted this").
function M.header_filter()
  -- Purges must run even on uncached/bypassed responses — LSCWP sends
  -- them on logged-in admin actions.
  local p = ngx.var.upstream_http_x_litespeed_purge
  if p and p ~= "" then
    do_purge(ngx.shared.dpc_tags, p)
  end

  local status = ngx.var.upstream_cache_status
  if not status or status == "" then return end
  if status == "BYPASS" and ngx.ctx.dpc_unknown then
    status = "MISS"
  end
  ngx.var.dpc_cache_status = status
  -- The header LiteSpeed itself stamps — page-cache checkers look for it.
  local hit = status == "HIT"
    or status == "STALE"
    or status == "UPDATING"
    or status == "REVALIDATED"
  ngx.header["X-LiteSpeed-Cache"] = hit and "hit" or "miss"
end

-- log phase: whenever nginx stored a fresh copy, record its tags and the
-- rewrite-phase generation. The record's TTL is the page's OWN max-age:
-- nginx stores for the proxy_cache_valid ceiling, and the record expiring
-- (-> unknown key -> refresh) is what enforces per-page freshness.
function M.log()
  local key = ngx.ctx.dpc_key
  if not key then return end
  if ngx.var.cookie__lscache_vary then return end -- never stored (conf)
  local status = ngx.var.upstream_cache_status
  if status ~= "BYPASS" and status ~= "MISS" and status ~= "EXPIRED" then
    return
  end
  -- Mirror the conf's $dpc_ls_nostore map: stored only when the app said
  -- public — and never ESI, which nginx cannot assemble.
  local lscc = (ngx.var.upstream_http_x_litespeed_cache_control or ""):lower()
  if
    lscc:find("no-cache", 1, true)
    or lscc:find("no-store", 1, true)
    or lscc:find("private", 1, true)
    or lscc:find("esi=on", 1, true)
    or not lscc:find("public", 1, true)
  then
    return
  end
  local ttl = tonumber(lscc:match("s%-maxage=(%d+)"))
    or tonumber(lscc:match("max%-age=(%d+)"))
    or DEFAULT_TTL
  if ttl == 0 then return end
  -- Tags: comma-separated; `public:` prefixes are scope decoration on a
  -- public response — strip them. (Private tags never reach here: private
  -- responses are rejected above.)
  local tags = {}
  for t in (ngx.var.upstream_http_x_litespeed_tag or ""):gmatch("[^,%s]+") do
    tags[#tags + 1] = (t:gsub("^public:", ""))
  end
  local val = ngx.ctx.dpc_gen .. "|" .. table.concat(tags, " ")
  local ok, err = ngx.shared.dpc_keys:set(key, val, ttl)
  if not ok then
    ngx.log(ngx.WARN, "dpc ls-purge: key record set failed: ", err)
  end
end

return M
