-- Smart-Safi Schema v2.0 — Dual fee: 15% per-order + 5% monthly admin
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'client' CHECK (role IN ('client','laundromat','admin','superadmin')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  fcm_token TEXT,
  token_version INT NOT NULL DEFAULT 0,
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMP,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS addresses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL,
  street TEXT NOT NULL,
  area VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL DEFAULT 'Nairobi',
  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS laundromat_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(150) NOT NULL,
  business_email VARCHAR(150) UNIQUE,
  business_phone VARCHAR(20),
  mpesa_till VARCHAR(30),
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 15.00,
  admin_fee_rate DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','suspended','rejected')),
  logo_url TEXT,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS laundromats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(150) NOT NULL,
  owner_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  mpesa_till VARCHAR(30),
  address TEXT NOT NULL,
  area VARCHAR(100),
  city VARCHAR(100) NOT NULL DEFAULT 'Nairobi',
  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 15.00,
  admin_fee_rate DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','rejected')),
  rating_avg DECIMAL(3,2) DEFAULT 0,
  rating_count INT NOT NULL DEFAULT 0,
  logo_url TEXT,
  description TEXT,
  operating_hours JSONB,
  onboarded_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS laundromat_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  laundromat_id UUID NOT NULL REFERENCES laundromats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_role VARCHAR(20) NOT NULL DEFAULT 'staff' CHECK (staff_role IN ('owner','manager','staff')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(laundromat_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'manager' CHECK (role IN ('owner','manager','staff','admin')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  price_per_unit DECIMAL(10,2) NOT NULL,
  unit VARCHAR(30) NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN ('standard','special')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS laundromat_services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  laundromat_id UUID NOT NULL REFERENCES laundromats(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  price_override DECIMAL(10,2),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(laundromat_id, service_id)
);

CREATE TABLE IF NOT EXISTS schedule_slots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slot_date DATE NOT NULL,
  slot_time TIME NOT NULL,
  slot_type VARCHAR(20) NOT NULL CHECK (slot_type IN ('pickup','delivery')),
  laundromat_id UUID REFERENCES laundromats(id),
  max_capacity INT NOT NULL DEFAULT 10,
  booked_count INT NOT NULL DEFAULT 0,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(slot_date, slot_time, slot_type)
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number VARCHAR(20) UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  laundromat_id UUID REFERENCES laundromats(id),
  pickup_address_id UUID REFERENCES addresses(id),
  delivery_address_id UUID REFERENCES addresses(id),
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','picked_up','washing','ironing','ready','out_for_delivery','delivered','cancelled')),
  pickup_time TIMESTAMP NOT NULL,
  delivery_time TIMESTAMP,
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
  platform_fee_pct DECIMAL(5,2) NOT NULL DEFAULT 15.00,
  platform_fee_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 100,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  driver_name VARCHAR(100),
  driver_phone VARCHAR(20),
  special_instructions TEXT,
  idempotency_key VARCHAR(100) UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id),
  service_name VARCHAR(100) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  special_instructions TEXT,
  line_total DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL,
  changed_by UUID REFERENCES users(id),
  note TEXT,
  changed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id),
  user_id UUID NOT NULL REFERENCES users(id),
  amount DECIMAL(10,2) NOT NULL,
  method VARCHAR(30) NOT NULL DEFAULT 'mpesa',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','refunded')),
  mpesa_checkout_request_id VARCHAR(100) UNIQUE,
  mpesa_receipt_number VARCHAR(50),
  transaction_reference VARCHAR(100),
  callback_received_at TIMESTAMP,
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disbursements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id),
  group_id UUID,
  laundromat_id UUID NOT NULL REFERENCES laundromats(id),
  gross_amount DECIMAL(10,2) NOT NULL,
  commission_rate DECIMAL(5,2) NOT NULL,
  commission_amount DECIMAL(10,2) NOT NULL,
  payout_amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','failed','on_hold')),
  mpesa_reference VARCHAR(100),
  failure_reason TEXT,
  initiated_at TIMESTAMP,
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(order_id)
);

CREATE TABLE IF NOT EXISTS admin_fee_invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID,
  laundromat_id UUID NOT NULL REFERENCES laundromats(id),
  billing_period VARCHAR(7) NOT NULL,
  monthly_gmv DECIMAL(10,2) NOT NULL,
  admin_fee_rate DECIMAL(5,2) NOT NULL,
  admin_fee_amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','waived','failed')),
  due_date DATE NOT NULL,
  mpesa_reference VARCHAR(100),
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(laundromat_id, billing_period)
);

-- Laundromat partner SaaS subscription plans (recurring platform fee, billed via the payment engine).
CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(60) NOT NULL UNIQUE,
  price DECIMAL(10,2) NOT NULL,
  interval VARCHAR(10) NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year')),
  features JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS laundromat_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID,
  laundromat_id UUID NOT NULL REFERENCES laundromats(id) ON DELETE CASCADE UNIQUE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','past_due','canceled')),
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  last_payment_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES laundromat_subscriptions(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  provider VARCHAR(30) NOT NULL DEFAULT 'mulaflow',
  provider_ref VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  period VARCHAR(7),
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subpay_ref ON subscription_payments(provider_ref);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) UNIQUE,
  client_id UUID NOT NULL REFERENCES users(id),
  laundromat_id UUID NOT NULL REFERENCES laundromats(id),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  is_flagged BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  order_id UUID REFERENCES orders(id),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_type VARCHAR(10) NOT NULL CHECK (sender_type IN ('client','agent','system')),
  sender_id UUID REFERENCES users(id),
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES users(id),
  actor_role VARCHAR(20),
  action VARCHAR(100) NOT NULL,
  resource VARCHAR(100),
  resource_id UUID,
  ip_address INET,
  user_agent TEXT,
  details JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_laundromat ON orders(laundromat_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_disbursements_lm ON disbursements(laundromat_id);
CREATE INDEX IF NOT EXISTS idx_disbursements_status ON disbursements(status);
CREATE INDEX IF NOT EXISTS idx_admin_fees_lm ON admin_fee_invoices(laundromat_id);
CREATE INDEX IF NOT EXISTS idx_payments_mpesa ON payments(mpesa_checkout_request_id);

-- ============================================
-- Multi-branch support: Add columns to existing tables if they don't exist
-- ============================================

-- Add group_id to laundromats if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'laundromats' AND column_name = 'group_id') THEN
    ALTER TABLE laundromats ADD COLUMN group_id UUID;
  END IF;
END $$;

-- Add is_main_branch to laundromats if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'laundromats' AND column_name = 'is_main_branch') THEN
    ALTER TABLE laundromats ADD COLUMN is_main_branch BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- Add group_id to laundromat_users if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'laundromat_users' AND column_name = 'group_id') THEN
    ALTER TABLE laundromat_users ADD COLUMN group_id UUID;
  END IF;
END $$;

-- Add can_access_all_branches to laundromat_users if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'laundromat_users' AND column_name = 'can_access_all_branches') THEN
    ALTER TABLE laundromat_users ADD COLUMN can_access_all_branches BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- Make laundromat_id nullable in laundromat_users if needed
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'laundromat_users' AND column_name = 'laundromat_id' AND is_nullable = 'NO') THEN
    ALTER TABLE laundromat_users ALTER COLUMN laundromat_id DROP NOT NULL;
  END IF;
END $$;

-- Add group_id to admin_fee_invoices if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_fee_invoices' AND column_name = 'group_id') THEN
    ALTER TABLE admin_fee_invoices ADD COLUMN group_id UUID;
  END IF;
END $$;

-- Add group_id to disbursements if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'disbursements' AND column_name = 'group_id') THEN
    ALTER TABLE disbursements ADD COLUMN group_id UUID;
  END IF;
END $$;

-- Add group_id to laundromat_subscriptions if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'laundromat_subscriptions' AND column_name = 'group_id') THEN
    ALTER TABLE laundromat_subscriptions ADD COLUMN group_id UUID;
  END IF;
END $$;

-- Update the generate_monthly_admin_fees function to include group_id
CREATE OR REPLACE FUNCTION generate_monthly_admin_fees(billing_month VARCHAR(7)) RETURNS INT AS $$
DECLARE lm RECORD; monthly_gmv DECIMAL(10,2); fee_amount DECIMAL(10,2); count_created INT := 0;
BEGIN
  FOR lm IN SELECT id,group_id,admin_fee_rate FROM laundromats WHERE status='active' AND admin_fee_rate > 0 LOOP
    SELECT COALESCE(SUM(o.subtotal),0) INTO monthly_gmv FROM orders o
    JOIN disbursements d ON d.order_id=o.id
    WHERE o.laundromat_id=lm.id AND TO_CHAR(o.created_at,'YYYY-MM')=billing_month AND o.status='delivered';
    IF monthly_gmv > 0 THEN
      fee_amount := ROUND(monthly_gmv * lm.admin_fee_rate / 100, 2);
      INSERT INTO admin_fee_invoices (group_id, laundromat_id,billing_period,monthly_gmv,admin_fee_rate,admin_fee_amount,due_date)
      VALUES (lm.group_id, lm.id,billing_month,monthly_gmv,lm.admin_fee_rate,fee_amount,(TO_DATE(billing_month||'-01','YYYY-MM-DD')+INTERVAL '1 month + 5 days')::DATE)
      ON CONFLICT (laundromat_id,billing_period) DO NOTHING;
      count_created := count_created + 1;
    END IF;
  END LOOP;
  RETURN count_created;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Add foreign key constraints for multi-branch columns
-- ============================================

-- Add foreign key for laundromats.group_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'laundromats' 
    AND constraint_name = 'fk_laundromats_group_id'
  ) THEN
    ALTER TABLE laundromats 
    ADD CONSTRAINT fk_laundromats_group_id 
    FOREIGN KEY (group_id) REFERENCES laundromat_groups(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add foreign key for laundromat_users.group_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'laundromat_users' 
    AND constraint_name = 'fk_laundromat_users_group_id'
  ) THEN
    ALTER TABLE laundromat_users 
    ADD CONSTRAINT fk_laundromat_users_group_id 
    FOREIGN KEY (group_id) REFERENCES laundromat_groups(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Add foreign key for group_user_roles.group_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'group_user_roles' 
    AND constraint_name = 'fk_group_user_roles_group_id'
  ) THEN
    ALTER TABLE group_user_roles 
    ADD CONSTRAINT fk_group_user_roles_group_id 
    FOREIGN KEY (group_id) REFERENCES laundromat_groups(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Add foreign key for disbursements.group_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'disbursements' 
    AND constraint_name = 'fk_disbursements_group_id'
  ) THEN
    ALTER TABLE disbursements 
    ADD CONSTRAINT fk_disbursements_group_id 
    FOREIGN KEY (group_id) REFERENCES laundromat_groups(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add foreign key for admin_fee_invoices.group_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'admin_fee_invoices' 
    AND constraint_name = 'fk_admin_fee_invoices_group_id'
  ) THEN
    ALTER TABLE admin_fee_invoices 
    ADD CONSTRAINT fk_admin_fee_invoices_group_id 
    FOREIGN KEY (group_id) REFERENCES laundromat_groups(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add foreign key for laundromat_subscriptions.group_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'laundromat_subscriptions' 
    AND constraint_name = 'fk_laundromat_subscriptions_group_id'
  ) THEN
    ALTER TABLE laundromat_subscriptions 
    ADD CONSTRAINT fk_laundromat_subscriptions_group_id 
    FOREIGN KEY (group_id) REFERENCES laundromat_groups(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Add unique constraint for laundromat_users (group_id, laundromat_id, user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'UNIQUE' AND table_name = 'laundromat_users' 
    AND constraint_name = 'uniq_laundromat_users_group_laundromat_user'
  ) THEN
    ALTER TABLE laundromat_users 
    ADD CONSTRAINT uniq_laundromat_users_group_laundromat_user 
    UNIQUE (group_id, laundromat_id, user_id);
  END IF;
END $$;

-- Update unique constraint for laundromat_users (laundromat_id, user_id) to allow NULL laundromat_id
DO $$
BEGIN
  -- Drop the old unique constraint if it exists (doesn't allow NULL)
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'UNIQUE' AND table_name = 'laundromat_users' 
    AND constraint_name = 'laundromat_users_laundromat_id_user_id_key'
  ) THEN
    ALTER TABLE laundromat_users DROP CONSTRAINT laundromat_users_laundromat_id_user_id_key;
  END IF;
  
  -- Check if the partial unique index already exists
  PERFORM 1 FROM pg_indexes 
  WHERE tablename = 'laundromat_users' AND indexname = 'uniq_laundromat_users_laundromat_user';
  
  -- Only create if it doesn't exist
  IF NOT FOUND THEN
    CREATE UNIQUE INDEX uniq_laundromat_users_laundromat_user 
    ON laundromat_users(laundromat_id, user_id) WHERE laundromat_id IS NOT NULL;
  END IF;
END $$;

-- Add unique constraint for group_user_roles (group_id, user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_type = 'UNIQUE' AND table_name = 'group_user_roles' 
    AND constraint_name = 'uniq_group_user_roles_group_user'
  ) THEN
    ALTER TABLE group_user_roles 
    ADD CONSTRAINT uniq_group_user_roles_group_user 
    UNIQUE (group_id, user_id);
  END IF;
END $$;

-- ============================================
-- Multi-branch indexes (must be after columns are added)
-- ============================================
CREATE INDEX IF NOT EXISTS idx_laundromats_group ON laundromats(group_id);
CREATE INDEX IF NOT EXISTS idx_laundromat_users_group ON laundromat_users(group_id);
CREATE INDEX IF NOT EXISTS idx_laundromat_users_laundromat ON laundromat_users(laundromat_id);
CREATE INDEX IF NOT EXISTS idx_group_user_roles_group ON group_user_roles(group_id);
CREATE INDEX IF NOT EXISTS idx_group_user_roles_user ON group_user_roles(user_id);

INSERT INTO services (name,description,price_per_unit,unit,category,sort_order) VALUES
  ('Dry Cleaning','Professional dry cleaning',350,'per item','standard',1),
  ('Premium Wash','Expert fabric care',80,'per kg','standard',2),
  ('Budget Wash','Standard cleaning',50,'per kg','standard',3),
  ('Iron & Fold','Professional ironing',30,'per item','standard',4),
  ('Wash & Fold','Full wash and fold',70,'per kg','standard',5),
  ('Delicate Care','Gentle wash for fine fabrics',90,'per item','standard',6),
  ('Express Service','Same-day turnaround',120,'per kg','standard',7),
  ('Roll Polishing','Traditional polishing',200,'per item','special',8),
  ('Antiseptic Wash','Hospital-grade antiseptic',60,'per kg','special',9),
  ('Fabric Softener','Luxurious softening',20,'per kg','special',10),
  ('Fabric Conditioner','Long-lasting freshness',20,'per kg','special',11)
ON CONFLICT (name) DO NOTHING;

-- Insert sample laundromat group for multi-branch support (only if columns exist)
DO $$
BEGIN
  -- Check if laundromat_groups table has all needed columns
  PERFORM 1 FROM information_schema.columns 
  WHERE table_name = 'laundromat_groups' AND column_name = 'business_email';
  
  IF FOUND THEN
    INSERT INTO laundromat_groups (name, business_email, business_phone, mpesa_till, commission_rate, admin_fee_rate, status, description)
    VALUES ('Quicklean Group','group@quicklean.co.ke','+254710141771','174379',15.00,5.00,'active','Smart-Safi founding partner group')
    ON CONFLICT (business_email) DO NOTHING;
  END IF;
END $$;

DO $$
BEGIN
  -- Check if laundromats table has group_id and is_main_branch columns
  PERFORM 1 FROM information_schema.columns 
  WHERE table_name = 'laundromats' AND column_name = 'group_id';
  
  IF FOUND THEN
    PERFORM 1 FROM information_schema.columns 
    WHERE table_name = 'laundromats' AND column_name = 'is_main_branch';
    
    IF FOUND THEN
      INSERT INTO laundromats (group_id, name, owner_name, email, phone, mpesa_till, address, area, city, latitude, longitude, commission_rate, admin_fee_rate, status, description, onboarded_at, is_main_branch)
      VALUES (
        (SELECT id FROM laundromat_groups WHERE business_email='group@quicklean.co.ke' LIMIT 1),
        'Quicklean Laundromat - Westlands','Titus Timan Turasha','ops@quicklean.co.ke','+254710141771','174379','14 Kenyatta Avenue','Westlands','Nairobi',-1.2680,36.8120,15.00,5.00,'active','Smart-Safi founding partner - Main Branch',NOW(),true
      )
      ON CONFLICT (email) DO NOTHING;
    END IF;
  END IF;
END $$;

INSERT INTO subscription_plans (name,price,interval,features,sort_order) VALUES
  ('Starter',1500,'month','["Listed on the client app","Up to 100 orders/month","Standard support"]',1),
  ('Pro',3500,'month','["Priority placement","Unlimited orders","Analytics","Priority support"]',2)
ON CONFLICT (name) DO NOTHING;

DO $$ DECLARE d DATE; t TIME;
BEGIN
  FOR i IN 0..13 LOOP
    d := CURRENT_DATE + i;
    IF EXTRACT(DOW FROM d) != 0 THEN
      FOREACH t IN ARRAY ARRAY['08:00','09:00','10:00','11:00','14:00','15:00','16:00','17:00']::TIME[] LOOP
        INSERT INTO schedule_slots(slot_date,slot_time,slot_type,max_capacity)
        VALUES (d,t,'pickup',8),(d,t,'delivery',8) ON CONFLICT (slot_date,slot_time,slot_type) DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION generate_monthly_admin_fees(billing_month VARCHAR(7)) RETURNS INT AS $$
DECLARE lm RECORD; monthly_gmv DECIMAL(10,2); fee_amount DECIMAL(10,2); count_created INT := 0;
BEGIN
  FOR lm IN SELECT id,group_id,admin_fee_rate FROM laundromats WHERE status='active' AND admin_fee_rate > 0 LOOP
    SELECT COALESCE(SUM(o.subtotal),0) INTO monthly_gmv FROM orders o
    JOIN disbursements d ON d.order_id=o.id
    WHERE o.laundromat_id=lm.id AND TO_CHAR(o.created_at,'YYYY-MM')=billing_month AND o.status='delivered';
    IF monthly_gmv > 0 THEN
      fee_amount := ROUND(monthly_gmv * lm.admin_fee_rate / 100, 2);
      INSERT INTO admin_fee_invoices (group_id, laundromat_id,billing_period,monthly_gmv,admin_fee_rate,admin_fee_amount,due_date)
      VALUES (lm.group_id, lm.id,billing_month,monthly_gmv,lm.admin_fee_rate,fee_amount,(TO_DATE(billing_month||'-01','YYYY-MM-DD')+INTERVAL '1 month + 5 days')::DATE)
      ON CONFLICT (laundromat_id,billing_period) DO NOTHING;
      count_created := count_created + 1;
    END IF;
  END LOOP;
  RETURN count_created;
END;
$$ LANGUAGE plpgsql;
