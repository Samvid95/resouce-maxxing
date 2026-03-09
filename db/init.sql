CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE records (
    id          SERIAL PRIMARY KEY,
    group_id    UUID NOT NULL,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    value       NUMERIC(10,2) NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_records_group_id ON records (group_id);

-- 5,000 sellers (UUIDs) x 20 items each = 100,000 rows
-- UUIDs are deterministic via md5('seller-N') so the load test can reproduce them
INSERT INTO records (group_id, name, category, value, active, created_at)
SELECT
    md5('seller-' || (gs / 20))::UUID AS group_id,
    (ARRAY['Widget','Gadget','Doohickey','Thingamajig','Gizmo','Contraption'])[1 + (floor(random() * 6))::INT] AS name,
    (ARRAY['electronics','clothing','food','sports','books','toys'])[1 + (floor(random() * 6))::INT] AS category,
    round((random() * 500 + 10)::NUMERIC, 2) AS value,
    random() > 0.2 AS active,
    now() - (floor(random() * 365) || ' days')::INTERVAL AS created_at
FROM generate_series(0, 99999) AS gs;
