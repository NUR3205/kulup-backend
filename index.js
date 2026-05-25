const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

// 1. ARA YAZILIMLAR (Büyük resimler için kapıları sonuna kadar açtık)
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(
  express.urlencoded({ limit: "50mb", extended: true, parameterLimit: 50000 }),
);

// 2. VERİTABANI BAĞLANTISI
const pool = new Pool({
  connectionString:
    "postgresql://neondb_owner:npg_fNRw27gixpUt@ep-orange-water-an5acdnp-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  ssl: { rejectUnauthorized: false },
});

const { Expo } = require("expo-server-sdk");
const nodemailer = require("nodemailer");

let expo = new Expo();

// Gmail Uygulama Şifreni Buraya Girmelisin
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "bandirmakampusapp@gmail.com",
    pass: "a1b2c3d4e5f6g7h8",
  },
});

// --- TOKEN KAYDETME ENDPOINT'İ ---
app.post("/save-token", async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token) return res.status(400).send("Geçersiz veri");

  try {
    const query = "UPDATE users SET expo_push_token = $1 WHERE id = $2";
    await pool.query(query, [token, userId]);
    res.json({
      success: true,
      message: "Cihaz bildirimi için Token kaydedildi.",
    });
  } catch (err) {
    console.error("Token kaydetme hatası:", err);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// --- DUYURU YAYINLA, BİLDİRİM VE E-POSTA GÖNDER ---
app.post("/announcements", async (req, res) => {
  const {
    title,
    content,
    category,
    is_important,
    department,
    teacher_id,
    teacher_name,
    course_name,
  } = req.body;

  try {
    // 1. Duyuruyu Veritabanına Kaydet
    const insertQuery = `
      INSERT INTO announcements (title, content, category, is_important, department, teacher_id, teacher_name, course_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `;
    const result = await pool.query(insertQuery, [
      title,
      content,
      category,
      is_important || false,
      department,
      teacher_id,
      teacher_name,
      course_name,
    ]);
    const newAnnouncement = result.rows[0];

    // 2. Rolü 'student' olanları bul
    const studentQuery =
      "SELECT email, expo_push_token FROM users WHERE role = 'student'";
    const { rows: students } = await pool.query(studentQuery);
    const studentEmails = students.map((u) => u.email).filter(Boolean);

    // 3. E-posta Gönderimi
    if (studentEmails.length > 0) {
      const mailOptions = {
        from: '"Kampüs Etkinlik Sistemi" <senin.projemailin@gmail.com>',
        to: studentEmails.join(","),
        subject: `📢 ${department} - Yeni Duyuru: ${title}`,
        text: `Sayın Öğrencimiz,\n\n${teacher_name} hocamız yeni bir duyuru yayınladı:\n\n"${content}"\n\nDetaylar için uygulamanızı kontrol edebilirsiniz.`,
      };
      transporter
        .sendMail(mailOptions)
        .catch((err) => console.error("Mail Gönderim Hatası:", err));
    }

    // 4. Anlık Bildirim (Push Notification) Gönderimi
    let messages = [];
    for (let student of students) {
      if (
        student.expo_push_token &&
        Expo.isExpoPushToken(student.expo_push_token)
      ) {
        messages.push({
          to: student.expo_push_token,
          sound: "default",
          title: `📢 ${teacher_name} Yeni Duyuru Yayınladı!`,
          body: title,
          data: { route: "home" },
        });
      }
    }

    if (messages.length > 0) {
      let chunks = expo.chunkPushNotifications(messages);
      (async () => {
        for (let chunk of chunks) {
          try {
            await expo.sendPushNotificationsAsync(chunk);
          } catch (error) {
            console.error("Expo Push Hatası:", error);
          }
        }
      })();
    }

    res.status(201).json(newAnnouncement);
  } catch (err) {
    console.error("Duyuru eklenirken kritik hata:", err);
    res.status(500).send("Duyuru yayınlanamadı.");
  }
});
// --- KAYIT OL ---
app.post("/register", async (req, res) => {
  try {
    const { fullName, email, password, role, clubEmail, authCode } = req.body;
    if (!email.endsWith("@ogr.bandirma.edu.tr")) {
      return res
        .status(400)
        .json({ success: false, message: "Sadece okul maili kullanılabilir." });
    }
    if (password.length !== 11) {
      return res
        .status(400)
        .json({ success: false, message: "TC No 11 haneli olmalıdır." });
    }
    await pool.query(
      "INSERT INTO users (name, email, password, role, club_email, auth_code) VALUES($1, $2, $3, $4, $5, $6)",
      [
        fullName,
        email.toLowerCase(),
        password,
        role,
        clubEmail || null,
        authCode || null,
      ],
    );
    res.json({ success: true, message: "Kayıt Başarılı" });
  } catch (err) {
    console.error("Kayıt Hatası:", err.message);
    res.status(500).json({
      success: false,
      message: "Bu e-posta ile zaten kayıt olunmuş olabilir.",
    });
  }
});

// --- GİRİŞ YAP ---
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await pool.query(
      "SELECT users.*, clubs.club_name FROM users LEFT JOIN clubs ON users.auth_code = clubs.auth_code WHERE users.email = $1 AND users.password = $2",
      [email, password],
    );
    if (user.rows.length > 0) {
      res.json({ user: user.rows[0] });
    } else {
      res.status(401).json({ message: "Hatalı mail veya TC No!" });
    }
  } catch (err) {
    res.status(500).json({ message: "Sunucu hatası." });
  }
});

// --- YENİ ETKİNLİK EKLE (FRONTEND İLE %100 UYUMLU) ---
app.post("/events", async (req, res) => {
  console.log("--- YENİ ETKİNLİK İSTEĞİ GELDİ ---");
  try {
    const {
      title,
      date,
      club_name,
      preview_text,
      detailed_content,
      image_url,
    } = req.body;

    if (!title) {
      return res
        .status(400)
        .json({ success: false, message: "Başlık verisi ulaşmadı." });
    }

    await pool.query(
      "INSERT INTO events (title, date, preview_text, detailed_content, club_name, image_url) VALUES($1, $2, $3, $4, $5, $6)",
      [title, date, preview_text, detailed_content, club_name, image_url],
    );

    console.log("Başarılı: Etkinlik Neon'a kaydedildi!");
    res
      .status(200)
      .json({ success: true, message: "Etkinlik başarıyla yayınlandı!" });
  } catch (err) {
    console.error("Veritabanı Hatası:", err.message);
    res
      .status(500)
      .json({ success: false, message: "Veritabanına kaydedilemedi." });
  }
});

app.get("/events", async (req, res) => {
  // Frontend'den gelen id'yi yakalıyoruz
  const { user_id } = req.query;

  try {
    const query = `
      SELECT e.*, 
      (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id)::INTEGER as participant_count,
      (SELECT COUNT(*) FROM favorites f WHERE f.event_id = e.id)::INTEGER as like_count,
      EXISTS(SELECT 1 FROM favorites f2 WHERE f2.event_id = e.id AND f2.user_id = $1) as is_favorite
      FROM events e 
      ORDER BY e.id DESC
    `;

    // user_id'yi güvenli bir şekilde sorguya gönderiyoruz
    const result = await pool.query(query, [user_id || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Etkinlikler çekilemedi.");
  }
});

// --- PROFİL İÇİN ETKİNLİKLER ---
app.get("/my-events/:userId", async (req, res) => {
  try {
    const myEvents = await pool.query("SELECT * FROM events ORDER BY id DESC");
    res.json(myEvents.rows);
  } catch (err) {
    res.status(500).json({ message: "Hata oluştu." });
  }
});

// --- ETKİNLİK SİL ---
app.delete("/events/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM events WHERE id = $1", [id]);
    res.json({ success: true, message: "Etkinlik başarıyla silindi." });
  } catch (err) {
    console.error("Silme hatası:", err.message);
    res.status(500).json({ error: "Silme işlemi başarısız." });
  }
});

// --- ETKİNLİĞE KATIL ---
app.post("/join-event", async (req, res) => {
  const { event_id, user_id, user_name } = req.body;
  try {
    const checkUser = await pool.query(
      "SELECT * FROM event_participants WHERE event_id = $1 AND user_name = $2",
      [event_id, user_name],
    );
    if (checkUser.rows.length > 0) {
      return res.status(400).send("Zaten kayıtlısınız");
    }
    await pool.query(
      "INSERT INTO event_participants (event_id, user_id, user_name) VALUES ($1, $2, $3)",
      [event_id, user_id, user_name],
    );
    res.status(200).send("Katılım başarılı");
  } catch (err) {
    console.error(err);
    res.status(500).send("Kayıt işlemi başarısız.");
  }
});

// --- ETKİNLİKTEN AYRIL ---
app.post("/leave-event", async (req, res) => {
  const { event_id, user_name } = req.body;
  try {
    await pool.query(
      "DELETE FROM event_participants WHERE event_id = $1 AND user_name = $2",
      [event_id, user_name],
    );
    res.status(200).send("Ayrılma başarılı");
  } catch (err) {
    console.error(err);
    res.status(500).send("Ayrılma işlemi başarısız.");
  }
});

// --- KULÜP KATILIMCILARINI LİSTELE ---

// --- BİR ETKİNLİĞİN KATILIMCILARINI GETİR (Detay sayfası için) ---
app.get("/event-participants/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM event_participants WHERE event_id = $1",
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Katılımcılar çekilemedi.");
  }
});
// --- BİR KULÜBÜN TÜM ETKİNLİK KATILIMCILARINI GETİR (Katılımcı listesi sayfası için) ---
app.get("/club-participants/:clubName", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ep.user_name, e.title as event_title 
       FROM event_participants ep 
       JOIN events e ON ep.event_id = e.id 
       WHERE e.club_name = $1`,
      [req.params.clubName],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Kulüp katılımcıları çekilemedi.");
  }
});

// --- ETKİNLİK DETAYI GETİR ---
app.get("/event-details/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM events WHERE id = $1", [
      req.params.id,
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Etkinlik detayı çekilemedi.");
  }
});

// --- KULÜP DETAYLARINI GETİR (Instagram ve Mail İçin) ---
app.get("/club-details/:clubName", async (req, res) => {
  try {
    const { clubName } = req.params;
    const result = await pool.query(
      "SELECT * FROM clubs WHERE club_name = $1",
      [clubName],
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ message: "Kulüp bulunamadı." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Kulüp bilgileri çekilemedi.");
  }
});

// --- KULÜP ÜYELİĞİ DURUMUNU KONTROL ET ---
app.get("/club-membership/:userId/:clubName", async (req, res) => {
  try {
    const { userId, clubName } = req.params;
    const result = await pool.query(
      "SELECT * FROM club_members WHERE user_id = $1 AND club_name = $2",
      [userId, clubName],
    );
    res.json({ isMember: result.rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).send("Üyelik durumu çekilemedi.");
  }
});

// --- KULÜBE KATIL ---
app.post("/join-club", async (req, res) => {
  try {
    const { user_id, club_name } = req.body;
    await pool.query(
      "INSERT INTO club_members (user_id, club_name) VALUES ($1, $2)",
      [user_id, club_name],
    );
    res.status(200).send("Kulübe başarıyla katılındı.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Kulübe katılım başarısız.");
  }
});

// --- KULÜPTEN AYRIL ---
app.post("/leave-club", async (req, res) => {
  try {
    const { user_id, club_name } = req.body;
    await pool.query(
      "DELETE FROM club_members WHERE user_id = $1 AND club_name = $2",
      [user_id, club_name],
    );
    res.status(200).send("Kulüpten ayrılındı.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Kulüpten ayrılma başarısız.");
  }
});

// --- ÖĞRENCİDEN DİLEK VE ŞİKAYET AL ---
app.post("/submit-feedback", async (req, res) => {
  try {
    const { user_id, user_name, club_name, message } = req.body;
    await pool.query(
      "INSERT INTO feedbacks (user_id, user_name, club_name, message) VALUES ($1, $2, $3, $4)",
      [user_id, user_name, club_name, message],
    );
    res.status(200).send("Geri bildirim başarıyla gönderildi.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Hata oluştu.");
  }
});

// --- BAŞKANA GELEN BİLDİRİMLERİ GÖNDER ---
app.get("/club-feedbacks/:clubName", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM feedbacks WHERE club_name = $1 ORDER BY created_at DESC",
      [req.params.clubName],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Bildirimler çekilemedi.");
  }
});

// --- ETKİNLİĞE YILDIZ VER ---
app.post("/rate-event", async (req, res) => {
  try {
    const { event_id, user_id, rating } = req.body;

    // Önce bu öğrenci bu etkinliğe daha önce puan vermiş mi bakalım
    const check = await pool.query(
      "SELECT * FROM event_ratings WHERE event_id = $1 AND user_id = $2",
      [event_id, user_id],
    );

    if (check.rows.length > 0) {
      // Daha önce vermişse, eski puanını yeni verdiği yıldızla değiştir (Güncelle)
      await pool.query(
        "UPDATE event_ratings SET rating = $1 WHERE event_id = $2 AND user_id = $3",
        [rating, event_id, user_id],
      );
    } else {
      // İlk defa veriyorsa yeni kayıt aç
      await pool.query(
        "INSERT INTO event_ratings (event_id, user_id, rating) VALUES ($1, $2, $3)",
        [event_id, user_id, rating],
      );
    }
    res.status(200).send("Puan başarıyla kaydedildi.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Puan kaydedilirken hata oluştu.");
  }
});

// --- ETKİNLİĞİN ORTALAMA YILDIZINI ÇEK ---
app.get("/event-rating/:eventId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT AVG(rating) as average_rating, COUNT(rating) as total_votes FROM event_ratings WHERE event_id = $1",
      [req.params.eventId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Puan çekilemedi.");
  }
});

// --- KULÜP DETAYLARINI GETİR ---
app.get("/club-details/:clubName", async (req, res) => {
  try {
    const { clubName } = req.params;
    const result = await pool.query(
      "SELECT * FROM clubs WHERE club_name = $1",
      [clubName],
    );
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ message: "Kulüp bulunamadı." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Sunucu hatası.");
  }
});

// === FAVORİLERE EKLE / ÇIKAR ===
app.post("/toggle-favorite", async (req, res) => {
  const { user_id, event_id } = req.body;
  try {
    // Önce bu etkinlik zaten favorilerde var mı diye bakıyoruz
    const check = await pool.query(
      "SELECT * FROM favorites WHERE user_id = $1 AND event_id = $2",
      [user_id, event_id],
    );

    if (check.rows.length > 0) {
      // Varsa, favorilerden çıkar (Sil)
      await pool.query(
        "DELETE FROM favorites WHERE user_id = $1 AND event_id = $2",
        [user_id, event_id],
      );
      res.json({ message: "Favorilerden çıkarıldı", isFavorite: false });
    } else {
      // Yoksa, favorilere ekle
      await pool.query(
        "INSERT INTO favorites (user_id, event_id) VALUES ($1, $2)",
        [user_id, event_id],
      );
      res.json({ message: "Favorilere eklendi", isFavorite: true });
    }
  } catch (error) {
    console.error("Favori işlemi hatası:", error);
    res.status(500).send("Sunucu hatası");
  }
});

// === KULLANICININ FAVORİ ETKİNLİKLERİNİ GETİR ===
app.get("/favorites/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    // JOIN işlemi ile favori tablosundaki event_id'leri alıp, etkinliklerin tüm detaylarını çekiyoruz
    const result = await pool.query(
      `
            SELECT events.* FROM events 
            JOIN favorites ON events.id = favorites.event_id 
            WHERE favorites.user_id = $1
            ORDER BY events.id DESC
        `,
      [user_id],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Favorileri getirme hatası:", error);
    res.status(500).send("Sunucu hatası");
  }
});

// --- 1. YENİ DUYURU YAYINLAMA ENDPOINT'İ (HOCALAR İÇİN) ---
// --- 1. YENİ DUYURU YAYINLAMA ENDPOINT'İ (DERS ADI EKLENDİ) ---
app.post("/announcements", async (req, res) => {
  // Frontend'den artık course_name bilgisini de alıyoruz
  const {
    title,
    content,
    category,
    is_important,
    department,
    teacher_id,
    teacher_name,
    course_name,
  } = req.body;

  try {
    const query = `
      INSERT INTO announcements (title, content, category, is_important, department, teacher_id, teacher_name, course_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `;
    const values = [
      title,
      content,
      category,
      is_important || false,
      department,
      teacher_id,
      teacher_name,
      course_name,
    ];
    const result = await pool.query(query, values);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Duyuru eklenirken hata oluştu:", err);
    res.status(500).send("Duyuru yayınlanamadı.");
  }
});

// --- TÜM DUYURULARI VEYA BÖLÜME GÖRE DUYURULARI ÇEKME ---
app.get("/announcements", async (req, res) => {
  const { department } = req.query; // Frontend'den gelen bölüm bilgisi

  try {
    let query = "SELECT * FROM announcements";
    let values = [];

    // Eğer frontend bir bölüm gönderdiyse, SADECE o bölümün duyurularını getir
    if (department) {
      query += " WHERE department = $1 ORDER BY created_at DESC";
      values.push(department);
    } else {
      // Bölüm yoksa (veya admin girerse) hepsini getir
      query += " ORDER BY created_at DESC";
    }

    const result = await pool.query(query, values);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Duyurular getirilirken hata oluştu:", err);
    res.status(500).send("Sunucu hatası.");
  }
});

// --- 1. DUYURU OKUNDUĞUNDA GÖRÜNTÜLENMEYİ KAYDETME ---
app.post("/announcements/:id/view", async (req, res) => {
  const { id } = req.params; // Duyuru ID'si
  const { user_id, user_name } = req.body;

  try {
    // ON CONFLICT DO NOTHING ile bir öğrencinin aynı duyuruda sayacı 2 kez artırmasını engelliyoruz
    const query = `
      INSERT INTO announcement_views (announcement_id, user_id, user_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (announcement_id, user_id) DO NOTHING
    `;
    await pool.query(query, [id, user_id, user_name]);
    res.status(200).send("Görüntülenme başarıyla kaydedildi.");
  } catch (err) {
    console.error("Görüntülenme kayıt hatası:", err);
    res.status(500).send("Sunucu hatası.");
  }
});

// --- 2. HOCALAR İÇİN: DUYURUYU GÖRENLERİ LİSTELEME ---
app.get("/announcements/:id/views", async (req, res) => {
  const { id } = req.params;
  try {
    const query = `
      SELECT user_name, viewed_at 
      FROM announcement_views 
      WHERE announcement_id = $1 
      ORDER BY viewed_at DESC
    `;
    const result = await pool.query(query, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error("Görüntüleyenler çekilirken hata:", err);
    res.status(500).send("Veriler getirilemedi.");
  }
});

// --- DUYURU SİLME ENDPOINT'İ ---
app.delete("/announcements/:id", async (req, res) => {
  const { id } = req.params;
  try {
    // Duyuruyu sil (NeonDB'de ON DELETE CASCADE ayarladığımız için görüntülenme sayıları da otomatik silinir, çok temiz!)
    await pool.query("DELETE FROM announcements WHERE id = $1", [id]);
    res.status(200).send("Duyuru başarıyla silindi.");
  } catch (err) {
    console.error("Duyuru silinirken hata:", err);
    res.status(500).send("Sunucu hatası.");
  }
});

// SUNUCUYU BAŞLAT
const PORT = 5000;
app.listen(PORT, () =>
  console.log(`🚀 Sunucu ${PORT} portunda tıkır tıkır çalışıyor...`),
);
