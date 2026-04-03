const { Pool } = require("pg");

const pool = new Pool({
  // Aşağıdaki tırnak içine Neon'dan kopyaladığın uzun linki yapıştır!
  connectionString:
    "postgresql://neondb_owner:npg_fNRw27gixpUt@ep-orange-water-an5acdnp-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  ssl: {
    rejectUnauthorized: false,
  },
});

module.exports = pool;
