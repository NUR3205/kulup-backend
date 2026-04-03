const Pool = require("pg").Pool;

const pool = new Pool({
  user: "postgres", // PgAdmin resminde gördük, bu doğru ✅
  password: "1234", // <-- BURAYA KENDİ ŞİFRENİ YAZ (Unuttuysan 12345 veya root dene)
  host: "localhost",
  port: 5432,
  database: "kampus_db", // <-- İşte aradığımız isim bu! 🎯
});

module.exports = pool;
