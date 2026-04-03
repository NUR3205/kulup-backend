const express = require("express");
const cors = require("cors");
const pool = require("./db"); // Neon.tech bulut veritabanı bağlantımız
const multer = require("multer");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json());

// Uploads klasörünü dışarıya açık hale getiriyoruz
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --- MULTER (FOTOĞRAF KAYDETME) AYARLARI ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    // Fotoğrafların isimleri çakışmasın diye sonuna tarih ekliyoruz
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage: storage });

// --- GİRİŞ YAP ---
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND password = $2",
      [email.toLowerCase(), password],
    );
    if (user.rows.length === 0)
      return res.status(401).json({ message: "Hatalı giriş!" });

    let userData = user.rows[0];
    // login içindeki başkan kontrol kısmı:
    if (userData.auth_code) {
      const club = await pool.query(
        "SELECT club_name FROM clubs WHERE auth_code = $1",
        [userData.auth_code],
      );
      if (club.rows.length > 0) {
        userData.club_name = club.rows[0].club_name;
        userData.role = "president";
      }
    }
    res.json({ message: "Başarılı", user: userData });
  } catch (err) {
    res.status(500).json({ message: "Sunucu hatası." });
  }
});

// --- KAYIT OL ---
app.post("/register", async (req, res) => {
  try {
    const { full_name, email, password, role, club_email, auth_code } =
      req.body;

    await pool.query(
      "INSERT INTO users (name, email, password, role, club_email, auth_code) VALUES($1, $2, $3, $4, $5, $6)",
      [
        full_name,
        email.toLowerCase(),
        password,
        role,
        club_email || null,
        auth_code || null,
      ],
    );
    res.json({ message: "Kayıt başarılı" });
  } catch (err) {
    console.log(err);
    res
      .status(500)
      .json({ message: "Kayıt hatası veya bu T.C./Mail zaten kullanımda." });
  }
});

// --- ETKİNLİĞE KATIL ---
app.post("/join", async (req, res) => {
  try {
    const { user_id, event_id } = req.body;

    // Çift Kayıt Kontrolü (Aynı öğrenci aynı etkinliğe 2 kez katılamaz)
    const checkUser = await pool.query(
      "SELECT * FROM registrations WHERE user_id = $1 AND event_id = $2",
      [user_id, event_id],
    );

    if (checkUser.rows.length > 0) {
      return res
        .status(400)
        .json({ message: "Bu etkinliğe zaten katıldınız! 😊" });
    }

    await pool.query(
      "INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)",
      [user_id, event_id],
    );
    res.json({ message: "Başarıyla katıldınız! ✅" });
  } catch (err) {
    res.status(500).json({ message: "Sunucu hatası." });
  }
});

// --- ETKİNLİKLERİ LİSTELE ---
app.get("/events", async (req, res) => {
  try {
    const allEvents = await pool.query("SELECT * FROM events ORDER BY id DESC");
    res.json(allEvents.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// --- KATILIMCILARI LİSTELEME ---
app.get("/event-participants/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;

    // JOIN kullanarak kayıtlı öğrencilerin isim ve maillerini çekiyoruz
    const participants = await pool.query(
      `SELECT users.name, users.email 
       FROM registrations 
       JOIN users ON registrations.user_id = users.user_id 
       WHERE registrations.event_id = $1`,
      [eventId],
    );

    res.json(participants.rows);
  } catch (err) {
    console.error("Katılımcı Çekme Hatası:", err.message);
    res.status(500).json([]);
  }
});

// --- KULÜP İSTATİSTİKLERİ (Toplam Katılımcı Sayısı) ---
app.get("/club-stats/:clubName", async (req, res) => {
  try {
    const { clubName } = req.params;
    const result = await pool.query(
      "SELECT COUNT(r.id) as total FROM registrations r JOIN events e ON r.event_id = e.id WHERE e.club_name = $1",
      [clubName],
    );
    res.json({ totalParticipants: result.rows[0].total || "0" });
  } catch (err) {
    console.error("İstatistik hatası:", err.message);
    res.status(500).json({ message: "Sunucu hatası" });
  }
});

// --- ETKİNLİK EKLE (FOTOĞRAF DESTEKLİ) ---
app.post("/add-event", upload.single("image"), async (req, res) => {
  try {
    const {
      title,
      description,
      date,
      club_name,
      detailed_content,
      preview_text,
    } = req.body;

    // Afiş URL'sini dinamik olarak oluştur (Render'da çalışması için)
    let imageUrl = null;
    if (req.file) {
      const baseUrl = req.protocol + "://" + req.get("host");
      imageUrl = `${baseUrl}/uploads/${req.file.filename}`;
    }

    await pool.query(
      "INSERT INTO events (title, description, date, club_name, image_url, detailed_content, preview_text) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        title,
        description,
        date,
        club_name,
        imageUrl,
        detailed_content,
        preview_text,
      ],
    );

    res.json({ message: "Etkinlik başarıyla yayınlandı! 🎉" });
  } catch (err) {
    console.error("Etkinlik ekleme hatası:", err);
    res.status(500).json({ message: "Sunucu hatası." });
  }
});

// --- SUNUCUYU BAŞLAT ---
// Render ortamı process.env.PORT kullanır, lokalde ise 5000 çalışır.
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Sunucu ${PORT} portunda aktif!`),
);
