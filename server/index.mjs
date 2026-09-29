import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { Pool } from "pg";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const maxZoom = Number(process.env.MAX_ZOOM ?? 14);
const maxTileCacheEntries = Number(process.env.MVT_CACHE_SIZE ?? 128);
const tileCache = new Map();

const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? "roads_demo",
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const tileQuery = `
  WITH bounds AS (
    SELECT ST_TileEnvelope($1, $2, $3) AS tile_geom
  ), tile AS (
    SELECT
      ST_AsMVTGeom(
        CASE
          WHEN $1 <= 7 THEN ST_SimplifyVW(r.geom_3857, 40)
          WHEN $1 <= 9 THEN ST_SimplifyVW(r.geom_3857, 15)
          WHEN $1 <= 11 THEN ST_SimplifyVW(r.geom_3857, 5)
          ELSE r.geom_3857
        END,
        b.tile_geom,
        4096,
        64,
        true
      ) AS geom,
      r.osm_id,
      r.code,
      r.fclass,
      r.name,
      r.ref,
      r.oneway,
      r.maxspeed,
      r.layer,
      r.bridge,
      r.tunnel
    FROM public.roads_demo r
    CROSS JOIN bounds b
      WHERE r.geom_3857 && b.tile_geom
      AND (
        ($1 <= 7 AND r.fclass IN ('motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary'))
        OR ($1 BETWEEN 8 AND 9 AND r.fclass IN (
          'motorway', 'motorway_link', 'trunk', 'trunk_link',
          'primary', 'secondary'
        ))
        OR ($1 BETWEEN 10 AND 11 AND r.fclass IN (
          'motorway', 'motorway_link', 'trunk', 'trunk_link',
          'primary', 'secondary', 'tertiary', 'residential', 'unclassified'
        ))
        OR $1 >= 12
      )
  )
  SELECT COALESCE(
    ST_AsMVT(tile, 'roads', 4096, 'geom'),
    decode('', 'hex')
  ) AS mvt
  FROM tile
  WHERE geom IS NOT NULL;
`;

const nearestRoadQuery = `
  WITH click_point AS (
    SELECT ST_Transform(
      ST_SetSRID(ST_Point($1, $2), 4326),
      3857
    ) AS geom
  )
  SELECT
    r.osm_id,
    r.code,
    r.fclass,
    r.name,
    r.ref,
    r.oneway,
    r.maxspeed,
    r.layer,
    r.bridge,
    r.tunnel,
    ST_AsGeoJSON(ST_Transform(r.geom, 4326), 6)::json AS geometry
  FROM public.roads_demo r
  CROSS JOIN click_point p
  WHERE ST_DWithin(r.geom_3857, p.geom, $3)
  ORDER BY r.geom_3857 <-> p.geom
  LIMIT 1;
`;

const spatialRoadQuery = `
  WITH input AS (
    SELECT ST_Transform(
      ST_MakeValid(
        ST_SetSRID(ST_GeomFromGeoJSON($1::json), 4326)
      ),
      3857
    ) AS geom
  ), search_area AS (
    SELECT
      geom,
      CASE
        WHEN ST_GeometryType(geom) = 'ST_Point' THEN ST_Buffer(geom, $2)
        ELSE geom
      END AS query_geom
    FROM input
  ), matched AS MATERIALIZED (
    SELECT
      r.fid,
      CASE
        WHEN ST_GeometryType(q.geom) = 'ST_Point' THEN ST_Distance(r.geom_3857, q.geom)
        ELSE 0
      END AS distance
    FROM public.roads_demo r
    CROSS JOIN search_area q
    WHERE r.geom_3857 && q.query_geom
      AND ST_Intersects(r.geom_3857, q.query_geom)
  ), paged_roads AS (
  SELECT
    r.fid,
    r.osm_id,
    r.code,
    r.fclass,
    r.name,
    r.ref,
    r.oneway,
    r.maxspeed,
    r.layer,
    r.bridge,
    r.tunnel,
    page.distance,
    ST_AsGeoJSON(ST_Transform(r.geom, 4326), 6)::json AS geometry
  FROM (
    SELECT fid, distance
    FROM matched
    ORDER BY distance, fid
    LIMIT $3 OFFSET $4
  ) page
  JOIN public.roads_demo r ON r.fid = page.fid
  )
  SELECT
    (SELECT count(*)::integer FROM matched) AS total,
    COALESCE(
      jsonb_agg(to_jsonb(paged_roads) - 'distance' ORDER BY distance, fid),
      '[]'::jsonb
    ) AS results
  FROM paged_roads;
`;

const searchRoadsQuery = `
  SELECT
    r.osm_id,
    r.code,
    r.fclass,
    r.name,
    r.ref,
    r.oneway,
    r.maxspeed,
    r.layer,
    r.bridge,
    r.tunnel,
    ST_AsGeoJSON(ST_Transform(r.geom, 4326), 6)::json AS geometry
  FROM public.roads_demo r
  WHERE (
    r.name ILIKE '%' || $1 || '%'
    OR r.ref ILIKE '%' || $1 || '%'
    OR r.osm_id = $1
  )
  ORDER BY
    CASE
      WHEN lower(r.name) = lower($1) THEN 0
      WHEN lower(r.ref) = lower($1) THEN 1
      WHEN lower(r.name) LIKE lower($1) || '%' THEN 2
      WHEN lower(r.ref) LIKE lower($1) || '%' THEN 3
      ELSE 4
    END,
    length(COALESCE(r.name, '')),
    r.fid
  LIMIT $2;
`;

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response, statusCode, body) {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readRequestBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let tooLarge = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > maxBytes) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("request body too large"));
        return;
      }
      resolve(body);
    });
    request.on("error", reject);
  });
}

function getTileCoordinates(pathname) {
  const match = pathname.match(/^\/tiles\/roads\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!match) {
    return null;
  }

  const [z, x, y] = match.slice(1).map(Number);
  const tileCount = 2 ** z;
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return null;
  }
  if (z < 0 || z > maxZoom || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
    return null;
  }

  return { z, x, y };
}

function getCachedTile(key) {
  const entry = tileCache.get(key);
  if (!entry) return undefined;
  tileCache.delete(key);
  tileCache.set(key, entry);
  return entry;
}

function cacheTile(key, tile) {
  const entry = { tile, gzip: undefined };
  tileCache.set(key, entry);
  while (tileCache.size > maxTileCacheEntries) {
    tileCache.delete(tileCache.keys().next().value);
  }
  return entry;
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    try {
      await pool.query("SELECT 1");
      sendJson(response, 200, { status: "ok", database: "roads_demo" });
    } catch (error) {
      console.error("Database health check failed", error);
      sendJson(response, 503, { status: "error", message: "database unavailable" });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/roads/nearest") {
    const longitude = Number(requestUrl.searchParams.get("lon"));
    const latitude = Number(requestUrl.searchParams.get("lat"));
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      sendJson(response, 400, { error: "invalid coordinates" });
      return;
    }

    try {
      const result = await pool.query(nearestRoadQuery, [longitude, latitude, 150]);
      if (result.rows.length === 0) {
        sendJson(response, 404, { error: "no road nearby" });
        return;
      }
      sendJson(response, 200, result.rows[0]);
    } catch (error) {
      console.error("Nearest road query failed", error);
      sendJson(response, 500, { error: "nearest road query failed" });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/roads/search") {
    const query = (requestUrl.searchParams.get("q") ?? "").trim();
    const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 20)
      : 10;

    if (!query) {
      sendJson(response, 400, { error: "search query is required" });
      return;
    }

    try {
      const result = await pool.query(searchRoadsQuery, [query, limit]);
      sendJson(response, 200, { query, results: result.rows });
    } catch (error) {
      console.error("Road search failed", error);
      sendJson(response, 500, { error: "road search failed" });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/roads/query") {
    let body;
    try {
      body = JSON.parse(await readRequestBody(request));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof SyntaxError ? "invalid JSON body" : "request body too large",
      });
      return;
    }

    const geometry = body?.geometry;
    const supportedGeometryTypes = new Set(["Point", "LineString", "Polygon"]);
    if (!geometry || !supportedGeometryTypes.has(geometry.type)) {
      sendJson(response, 400, { error: "geometry must be a Point, LineString, or Polygon" });
      return;
    }

    const requestedLimit = Number(body.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 100;
    const offset = Number(body.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) {
      sendJson(response, 400, { error: "invalid query offset" });
      return;
    }
    const requestedTolerance = Number(body.pointToleranceMeters ?? 150);
    const pointToleranceMeters = Number.isFinite(requestedTolerance)
      ? Math.min(Math.max(requestedTolerance, 1), 500)
      : 150;

    try {
      const result = await pool.query(spatialRoadQuery, [
        JSON.stringify(geometry),
        pointToleranceMeters,
        limit,
        offset,
      ]);
      const { total, results } = result.rows[0];
      sendJson(response, 200, {
        geometryType: geometry.type,
        count: results.length,
        total,
        offset,
        hasMore: offset + results.length < total,
        results,
      });
    } catch (error) {
      console.error("Spatial road query failed", error);
      sendJson(response, 400, { error: "invalid spatial query geometry" });
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  const coordinates = getTileCoordinates(requestUrl.pathname);
  if (!coordinates) {
    sendJson(response, 404, { error: "route not found or tile coordinates are invalid" });
    return;
  }

  try {
    const cacheKey = `${coordinates.z}/${coordinates.x}/${coordinates.y}`;
    let cacheEntry = getCachedTile(cacheKey);
    const cacheStatus = cacheEntry ? "HIT" : "MISS";
    if (!cacheEntry) {
      const result = await pool.query(tileQuery, [coordinates.z, coordinates.x, coordinates.y]);
      const tile = result.rows[0]?.mvt ?? Buffer.alloc(0);
      cacheEntry = cacheTile(cacheKey, tile);
    }

    const acceptsGzip = String(request.headers["accept-encoding"] ?? "").includes("gzip");
    const responseTile = acceptsGzip && cacheEntry.tile.length > 256
      ? (cacheEntry.gzip ??= gzipSync(cacheEntry.tile))
      : cacheEntry.tile;
    response.writeHead(200, {
      "Content-Type": "application/vnd.mapbox-vector-tile",
      "Cache-Control": "public, max-age=3600",
      "Content-Length": responseTile.length,
      "Vary": "Accept-Encoding",
      "X-MVT-Cache": cacheStatus,
      ...(responseTile !== cacheEntry.tile ? { "Content-Encoding": "gzip" } : {}),
    });
    response.end(responseTile);
  } catch (error) {
    console.error("MVT query failed", error);
    sendJson(response, 500, { error: "tile query failed" });
  }
});

server.listen(port, host, () => {
  console.log(`Road MVT server listening at http://${host}:${port}`);
});

async function shutdown() {
  server.close();
  await pool.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
