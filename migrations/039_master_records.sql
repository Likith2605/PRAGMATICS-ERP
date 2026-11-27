-- Master Data: Customers, Vendors, Machines, and Company Settings.

CREATE TABLE IF NOT EXISTS customers (
  id text PRIMARY KEY,
  company_name text NOT NULL,
  customer_code text NOT NULL DEFAULT '',
  gstin text NOT NULL DEFAULT '',
  pan text NOT NULL DEFAULT '',
  contact_person text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  pincode text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS customers_name_idx
  ON customers (lower(company_name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customers_gstin_idx
  ON customers (gstin) WHERE gstin <> '' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS vendors (
  id text PRIMARY KEY,
  vendor_code text NOT NULL DEFAULT '',
  name text NOT NULL,
  gstin text NOT NULL DEFAULT '',
  pan text NOT NULL DEFAULT '',
  contact_person text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS vendors_name_idx
  ON vendors (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS vendors_gstin_idx
  ON vendors (gstin) WHERE gstin <> '' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS machines (
  machine_id text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Active',
  hourly_rate numeric(10, 2) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS company_settings (
  id text PRIMARY KEY DEFAULT 'primary',
  company_name text NOT NULL DEFAULT 'PRAGMATICS',
  address text NOT NULL DEFAULT '',
  gstin text NOT NULL DEFAULT '',
  pan text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  bank_name text NOT NULL DEFAULT '',
  account_number text NOT NULL DEFAULT '',
  ifsc_code text NOT NULL DEFAULT '',
  branch text NOT NULL DEFAULT '',
  logo_url text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
