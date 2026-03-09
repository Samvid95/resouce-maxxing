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

-- 10 distinct UUIDs, each with 10,000 rows = 100,000 total
INSERT INTO records (group_id, name, category, value, active, created_at)
SELECT
    (ARRAY[
        'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f',
        'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80',
        'e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8091',
        'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8091a2',
        '17b8c9d0-e1f2-4a3b-4c5d-6e7f8091a2b3',
        '28c9d0e1-f2a3-4b4c-5d6e-7f8091a2b3c4',
        '39d0e1f2-a3b4-4c5d-6e7f-8091a2b3c4d5',
        '40e1f2a3-b4c5-4d6e-7f80-91a2b3c4d5e6'
    ]::UUID[])[1 + (gs / 10000)] AS group_id,
    (ARRAY['Widget','Gadget','Doohickey','Thingamajig','Gizmo','Contraption'])[1 + (floor(random() * 6))::INT] AS name,
    (ARRAY['electronics','clothing','food','sports','books','toys'])[1 + (floor(random() * 6))::INT] AS category,
    round((random() * 500 + 10)::NUMERIC, 2) AS value,
    random() > 0.2 AS active,
    now() - (floor(random() * 365) || ' days')::INTERVAL AS created_at
FROM generate_series(0, 99999) AS gs;
