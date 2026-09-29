CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS roads_demo_name_trgm_idx
  ON public.roads_demo USING gin (name gin_trgm_ops)
  WHERE name IS NOT NULL AND name <> '';

CREATE INDEX IF NOT EXISTS roads_demo_ref_trgm_idx
  ON public.roads_demo USING gin (ref gin_trgm_ops)
  WHERE ref IS NOT NULL AND ref <> '';

CREATE INDEX IF NOT EXISTS roads_demo_osm_id_idx
  ON public.roads_demo (osm_id);

ANALYZE public.roads_demo;
