-- Migration: turn the flat services table into a 3-tier hierarchy
-- (Residential/Commercial/Upholstery/Laundry/Pest/Sanitation/Car Detailing)
-- Already tested against live Postgres 16, including idempotency (safe to
-- re-run on every deploy, exactly like the rest of schema.sql).

ALTER TABLE services ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS tier SMALLINT NOT NULL DEFAULT 1 CHECK (tier IN (1,2,3));
ALTER TABLE services ALTER COLUMN price_per_unit DROP NOT NULL;
ALTER TABLE services ALTER COLUMN unit DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_services_parent ON services(parent_id);

-- Retire the old flat catalog, but ONLY where nothing references it yet
-- (safe on both a fresh install and one with real order/selection history)
DELETE FROM services s
WHERE s.tier = 1 AND s.parent_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.service_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM laundromat_services ls WHERE ls.service_id = s.id)
  AND s.name IN ('Dry Cleaning','Premium Wash','Budget Wash','Iron & Fold','Wash & Fold','Delicate Care','Express Service','Roll Polishing','Antiseptic Wash','Fabric Softener','Fabric Conditioner');

-- Seed the new tiered tree. ON CONFLICT ... DO UPDATE (not DO NOTHING) so that
-- RETURNING always yields an id -- whether freshly inserted or already present --
-- which is what lets the tree-building variables below work on re-runs too.
DO $$
DECLARE
  v_residential UUID; v_commercial UUID; v_upholstery UUID; v_laundry UUID;
  v_pest UUID; v_sanitation UUID;
  v_specific_room UUID; v_institution UUID; v_washing UUID; v_washroom UUID;
BEGIN
  INSERT INTO services(name,tier,category,is_active,sort_order) VALUES ('Residential Cleaning',1,'special',true,1)
    ON CONFLICT (name) DO UPDATE SET tier=1 RETURNING id INTO v_residential;
  INSERT INTO services(name,tier,category,is_active,sort_order) VALUES ('Commercial Cleaning',1,'special',true,2)
    ON CONFLICT (name) DO UPDATE SET tier=1 RETURNING id INTO v_commercial;
  INSERT INTO services(name,tier,category,is_active,sort_order) VALUES ('Upholstery & Carpet Cleaning',1,'special',true,3)
    ON CONFLICT (name) DO UPDATE SET tier=1 RETURNING id INTO v_upholstery;
  INSERT INTO services(name,tier,category,is_active,sort_order) VALUES ('Laundry Services',1,'standard',true,4)
    ON CONFLICT (name) DO UPDATE SET tier=1 RETURNING id INTO v_laundry;
  INSERT INTO services(name,tier,category,is_active,sort_order) VALUES ('Pest Control',1,'special',true,5)
    ON CONFLICT (name) DO UPDATE SET tier=1 RETURNING id INTO v_pest;
  INSERT INTO services(name,tier,category,is_active,sort_order) VALUES ('Sanitation & Hygiene Services',1,'special',true,6)
    ON CONFLICT (name) DO UPDATE SET tier=1 RETURNING id INTO v_sanitation;
  INSERT INTO services(name,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Car Detailing',1,'special',true,1500,'per vehicle',7)
    ON CONFLICT (name) DO UPDATE SET tier=1;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Deep Cleaning',v_residential,2,'special',true,3500,'per visit',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_residential,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Regular Maintenance / General Cleaning',v_residential,2,'special',true,2000,'per visit',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_residential,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,sort_order) VALUES ('Specific Room/Area Cleaning',v_residential,2,'special',true,3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_residential,tier=2 RETURNING id INTO v_specific_room;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Office Cleaning',v_commercial,2,'special',true,4000,'per visit',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_commercial,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Post-Construction Cleaning',v_commercial,2,'special',true,8000,'per visit',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_commercial,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,sort_order) VALUES ('Institution Cleaning',v_commercial,2,'special',true,3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_commercial,tier=2 RETURNING id INTO v_institution;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Standard Sofa Set Cleaning',v_upholstery,2,'special',true,2500,'per set',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_upholstery,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Leather Sofa Set Cleaning',v_upholstery,2,'special',true,3500,'per set',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_upholstery,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Carpet Cleaning',v_upholstery,2,'special',true,300,'per sqm',3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_upholstery,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Mattress Cleaning',v_upholstery,2,'special',true,1800,'per mattress',4)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_upholstery,tier=2;

  INSERT INTO services(name,parent_id,tier,category,is_active,sort_order) VALUES ('Washing',v_laundry,2,'standard',true,1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_laundry,tier=2 RETURNING id INTO v_washing;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Leather Cleaning',v_laundry,2,'special',true,600,'per item',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_laundry,tier=2;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Bedbugs',v_pest,2,'special',true,3500,'per room',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_pest,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Cockroaches',v_pest,2,'special',true,2500,'per visit',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_pest,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Ants',v_pest,2,'special',true,2000,'per visit',3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_pest,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Rats',v_pest,2,'special',true,3000,'per visit',4)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_pest,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Bees',v_pest,2,'special',true,4000,'per visit',5)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_pest,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Fleas',v_pest,2,'special',true,3000,'per visit',6)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_pest,tier=2;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Sanitary Bins',v_sanitation,2,'special',true,1200,'per month',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_sanitation,tier=2;
  INSERT INTO services(name,parent_id,tier,category,is_active,sort_order) VALUES ('Washroom Hygiene Solutions',v_sanitation,2,'special',true,2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_sanitation,tier=2 RETURNING id INTO v_washroom;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Bedroom Cleaning',v_specific_room,3,'special',true,800,'per room',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_specific_room,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Kitchen Cleaning',v_specific_room,3,'special',true,1200,'per kitchen',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_specific_room,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Bathroom Cleaning',v_specific_room,3,'special',true,900,'per bathroom',3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_specific_room,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Living Room Cleaning',v_specific_room,3,'special',true,1000,'per room',4)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_specific_room,tier=3;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Retail Store Cleaning',v_institution,3,'special',true,5000,'per visit',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_institution,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Restaurant/Cafe Cleaning',v_institution,3,'special',true,6000,'per visit',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_institution,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Club/Bar Cleaning',v_institution,3,'special',true,7000,'per visit',3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_institution,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Supermarket Cleaning',v_institution,3,'special',true,10000,'per visit',4)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_institution,tier=3;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Dry & Fold',v_washing,3,'standard',true,70,'per kg',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_washing,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Ironing',v_washing,3,'standard',true,30,'per item',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_washing,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Pressing',v_washing,3,'standard',true,40,'per item',3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_washing,tier=3;

  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Paper Rolls',v_washroom,3,'special',true,500,'per month',1)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_washroom,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Dispensers',v_washroom,3,'special',true,1500,'per unit',2)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_washroom,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Pedal Bins',v_washroom,3,'special',true,800,'per unit',3)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_washroom,tier=3;
  INSERT INTO services(name,parent_id,tier,category,is_active,price_per_unit,unit,sort_order) VALUES ('Sanitizers',v_washroom,3,'special',true,600,'per unit',4)
    ON CONFLICT (name) DO UPDATE SET parent_id=v_washroom,tier=3;
END $$;
