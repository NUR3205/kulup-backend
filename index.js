const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { Expo } = require("expo-server-sdk");
const cron = require("node-cron");
const app = express();

// 1. ARA YAZILIMLAR
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

// 3. EXPO BİLDİRİM KURULUMU
let expo = new Expo();

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

// --- DUYURU YAYINLA, BİLDİRİM VE GERÇEK E-POSTA GÖNDER (BREVO API) ---
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

    // 2. Sadece hocanın bölümündeki öğrencileri ve cihaz token'larını bul
    const studentQuery =
      "SELECT email, expo_push_token FROM users WHERE role = 'student' AND department = $1";
    const { rows: students } = await pool.query(studentQuery, [department]);

    // Veritabanındaki gerçek öğrenci maillerini listele
    const studentEmails = students.map((u) => u.email).filter(Boolean);

    // 3. BREVO HTTP API İLE GERÇEK E-POSTA GÖNDERİMİ
    if (studentEmails.length > 0) {
      const toAddresses = studentEmails.map((email) => ({ email: email }));

      fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sender: {
            name: "Kampüs Etkinlik Sistemi",
            email: "bandirmakampusapp@gmail.com",
          },
          to: toAddresses,
          subject: `📢 ${department} - Yeni Duyuru: ${title}`,
          htmlContent: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
              <h2 style="color: #0984e3;">Sayın Öğrencimiz,</h2>
              <p><strong>${teacher_name}</strong> hocamız yeni bir akademik duyuru yayınladı:</p>
              <blockquote style="background: #f9f9f9; padding: 15px; border-left: 4px solid #0984e3; font-style: italic;">
                "${content}"
              </blockquote>
              <p style="font-size: 12px; color: #777; margin-top: 20px;">Detaylar için uygulamanıza giriş yapabilirsiniz.</p>
            </div>
          `,
        }),
      })
        .then((response) =>
          console.log(
            `Brevo ile ${department} öğrencilerine mailler başarıyla fırlatıldı!`,
          ),
        )
        .catch((err) => console.error("Brevo Mail Hatası:", err));
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
  const { fullName, email, password, role, clubEmail, authCode, department } =
    req.body;

  try {
    const userExists = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email],
    );
    if (userExists.rows.length > 0) {
      return res
        .status(400)
        .json({ message: "Bu e-posta adresiyle zaten bir hesap mevcut." });
    }

    const newUser = await pool.query(
      "INSERT INTO users (name, email, password, role, club_email, auth_code, department) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [fullName, email, password, role, clubEmail, authCode, department],
    );

    res.status(200).json({
      message: "Kayıt başarıyla tamamlandı.",
      user: newUser.rows[0],
    });
  } catch (err) {
    console.error("🚨 BACKEND KAYIT HATASI:", err.message);
    res
      .status(500)
      .json({ message: "Sunucu hatası meydana geldi: " + err.message });
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

// === KULÜP KODUNU (AUTH_CODE) SIFIRLAMA API'Sİ (TEST MODU) ===
app.post("/forgot-club-code", async (req, res) => {
  const { email } = req.body;

  try {
    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND role = 'president'",
      [email],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        message: "Bu e-posta adresine ait bir kulüp başkanı hesabı bulunamadı.",
      });
    }

    const user = userResult.rows[0];
    const newAuthCode = Math.floor(100000 + Math.random() * 900000).toString();

    await pool.query("UPDATE users SET auth_code = $1 WHERE email = $2", [
      newAuthCode,
      email,
    ]);

    fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: {
          name: "Kampüs Etkinlik Sistemi",
          email: "bandirmakampusapp@gmail.com",
        },
        to: [{ email: "serifenuraslan705@gmail.com" }],
        subject: `🔐 Kulüp Kodunuz Sıfırlandı!`,
        htmlContent: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #0984e3;">Merhaba Sayın Başkan,</h2>
            <p><strong>${user.club_name}</strong> paneline giriş yapabilmeniz için yeni güvenlik kodunuz aşağıdadır:</p>
            <div style="background: #f1f2f6; padding: 15px; margin: 20px 0; border-radius: 10px; text-align: center; font-size: 28px; font-weight: bold; color: #2d3436; letter-spacing: 5px;">
              ${newAuthCode}
            </div>
            <p style="font-size: 13px; color: #777;">Bu bir test mailidir. Gerçek sistemde bu mail sadece kulübün resmi adresine gidecektir.</p>
          </div>
        `,
      }),
    });

    res.status(200).json({
      message: "Yeni kod e-posta adresinize gönderildi.",
      newCode: newAuthCode,
    });
  } catch (err) {
    console.error("Şifre sıfırlama hatası:", err);
    res.status(500).json({ message: "Sunucu hatası meydana geldi." });
  }
});

// === KULLANICININ KENDİ BELİRLEDİĞİ YENİ KULÜP KODUNU KAYDETME API'Sİ ===
app.post("/update-club-code", async (req, res) => {
  const { email, newCode } = req.body;

  try {
    await pool.query(
      "UPDATE users SET auth_code = $1 WHERE email = $2 AND role = 'president'",
      [newCode, email],
    );
    res.status(200).json({ message: "Kulüp kodunuz başarıyla güncellendi!" });
  } catch (err) {
    console.error("Yeni kod kaydetme hatası:", err);
    res.status(500).json({ message: "Sunucu hatası meydana geldi." });
  }
});

// En üste diğer require'ların yanına bunu eklemeyi unutma:
// const cron = require("node-cron");

// --- YENİ ETKİNLİK EKLE (OTOMATİK SİLİNME TARİHİ İLE) ---
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
      real_date, // Frontenden gelen gerçek zaman damgası
    } = req.body;

    if (!title) {
      return res
        .status(400)
        .json({ success: false, message: "Başlık verisi ulaşmadı." });
    }

    // 1. GÜVENLİK: Tabloda real_date sütunu yoksa anında oluşturur (Çökmeyi engeller)
    await pool.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS real_date TIMESTAMP;`,
    );

    // 2. Veriyi gerçek tarihiyle birlikte kaydet
    await pool.query(
      "INSERT INTO events (title, date, preview_text, detailed_content, club_name, image_url, real_date) VALUES($1, $2, $3, $4, $5, $6, $7)",
      [
        title,
        date,
        preview_text,
        detailed_content,
        club_name,
        image_url,
        real_date,
      ],
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

// === OTOMATİK ETKİNLİK SİLİCİ (CRON JOB) ===
// Bu kod her gece saat tam 00:00'da tetiklenir ve tarihi geçmiş etkinlikleri çöpe atar.
cron.schedule("0 0 * * *", async () => {
  console.log("🧹 [CRON JOB] Günlük etkinlik temizlik rutini başlatıldı...");
  try {
    // real_date sütunundaki tarih dünden eskiyse o satırı siler
    const result = await pool.query(
      "DELETE FROM events WHERE real_date < CURRENT_DATE RETURNING *",
    );
    console.log(
      `✅ [CRON JOB] Süresi dolan ${result.rowCount} etkinlik sistemden silindi.`,
    );
  } catch (err) {
    console.error("🚨 [CRON JOB] Temizlik sırasında hata oluştu:", err.message);
  }
});

// --- TÜM ETKİNLİKLERİ ÇEK ---
app.get("/events", async (req, res) => {
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
    const result = await pool.query(query, [user_id || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Etkinlikler çekilemedi.");
  }
});

// ÖĞRENCİNİN SADECE KAYDOLDUĞU ETKİNLİKLERİ GETİREN API UCU
app.get("/my-events/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `SELECT e.* FROM events e 
       JOIN event_participants ep ON e.id = ep.event_id 
       WHERE ep.user_id = $1`,
      [userId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Katıldığım etkinlikler çekilirken hata:", error);
    res.status(500).json({ error: "Sunucu hatası" });
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

// Benzersiz (Unique) katılımcı sayısını getiren API ucu
app.get("/unique-participants", async (req, res) => {
  const { club_name } = req.query;

  try {
    let result;

    if (club_name) {
      result = await pool.query(
        `SELECT COUNT(DISTINCT ep.user_id) AS total_count
         FROM event_participants ep 
         JOIN events e ON ep.event_id = e.id 
         WHERE e.club_name = $1`,
        [club_name],
      );
    } else {
      result = await pool.query(
        "SELECT COUNT(DISTINCT user_id) AS total_count FROM event_participants",
      );
    }

    const totalUnique = parseInt(result.rows[0].total_count) || 0;
    res.json({ totalUnique });
  } catch (error) {
    console.error("Benzersiz katılımcı hatası:", error);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// --- BİR KULÜBÜN TÜM ETKİNLİK KATILIMCILARINI GETİR ---
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

// --- HOCANIN / BAŞKANIN ÖĞRENCİYE CEVAP YAZMASI ---
app.post("/reply-feedback", async (req, res) => {
  const { feedback_id, teacher_message } = req.body;

  if (!feedback_id || !teacher_message) {
    return res.status(400).send("Geçersiz veri");
  }

  try {
    // 1. GÜVENLİK ADIMI: Tabloda teacher_reply adında bir sütun var mı kontrol et, yoksa anında yarat!
    // Uygulama çökmesini engeller
    await pool.query(`
      ALTER TABLE feedbacks 
      ADD COLUMN IF NOT EXISTS teacher_reply TEXT;
    `);

    // 2. Cevabı veritabanına kaydet (Güncelle)
    const updateQuery = `
      UPDATE feedbacks 
      SET teacher_reply = $1 
      WHERE id = $2 
      RETURNING *;
    `;
    const result = await pool.query(updateQuery, [
      teacher_message,
      feedback_id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).send("Bu mesaja ulaşılamadı.");
    }

    res
      .status(200)
      .json({ success: true, message: "Cevabınız başarıyla iletildi." });
  } catch (err) {
    console.error("Cevap yazılırken hata:", err);
    res.status(500).send("Sunucu hatası.");
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
    const check = await pool.query(
      "SELECT * FROM event_ratings WHERE event_id = $1 AND user_id = $2",
      [event_id, user_id],
    );

    if (check.rows.length > 0) {
      await pool.query(
        "UPDATE event_ratings SET rating = $1 WHERE event_id = $2 AND user_id = $3",
        [rating, event_id, user_id],
      );
    } else {
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

// === FAVORİLERE EKLE / ÇIKAR ===
app.post("/toggle-favorite", async (req, res) => {
  const { user_id, event_id } = req.body;
  try {
    const check = await pool.query(
      "SELECT * FROM favorites WHERE user_id = $1 AND event_id = $2",
      [user_id, event_id],
    );

    if (check.rows.length > 0) {
      await pool.query(
        "DELETE FROM favorites WHERE user_id = $1 AND event_id = $2",
        [user_id, event_id],
      );
      res.json({ message: "Favorilerden çıkarıldı", isFavorite: false });
    } else {
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

// --- TÜM DUYURULARI VEYA BÖLÜME GÖRE DUYURULARI ÇEKME ---
app.get("/announcements", async (req, res) => {
  const { department } = req.query;

  try {
    let query = "SELECT * FROM announcements";
    let values = [];

    if (department) {
      query += " WHERE department = $1 ORDER BY created_at DESC";
      values.push(department);
    } else {
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
  const { id } = req.params;
  const { user_id, user_name } = req.body;

  try {
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
    await pool.query("DELETE FROM announcements WHERE id = $1", [id]);
    res.status(200).send("Duyuru başarıyla silindi.");
  } catch (err) {
    console.error("Duyuru silinirken hata:", err);
    res.status(500).send("Sunucu hatası.");
  }
});

// Öğrencinin bölümüne göre Hocalara atanmış dersleri getiren API ucu
app.get("/courses", async (req, res) => {
  const { department } = req.query;

  try {
    const result = await pool.query(
      "SELECT DISTINCT course_name FROM users WHERE department = $1 AND course_name IS NOT NULL",
      [department],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Dersler çekilirken hata oluştu:", error);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// ETKİNLİK DETAYINDAKİ KATILIMCI LİSTESİNİ VE BUTONU DÜZELTEN API UCU
app.get("/event-participants/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "SELECT user_id, user_name FROM event_participants WHERE event_id = $1",
      [id],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Katılımcılar çekilirken hata:", error);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// 📌 1. DUYURU KAYDETME / ÇIKARMA API'Sİ
app.post("/toggle-saved-announcement", async (req, res) => {
  const { user_id, announcement_id } = req.body;
  try {
    const check = await pool.query(
      "SELECT * FROM saved_announcements WHERE user_id = $1 AND announcement_id = $2",
      [user_id, announcement_id],
    );

    if (check.rows.length > 0) {
      await pool.query(
        "DELETE FROM saved_announcements WHERE user_id = $1 AND announcement_id = $2",
        [user_id, announcement_id],
      );
      res.json({ status: "removed" });
    } else {
      await pool.query(
        "INSERT INTO saved_announcements (user_id, announcement_id) VALUES ($1, $2)",
        [user_id, announcement_id],
      );
      res.json({ status: "added" });
    }
  } catch (error) {
    console.error("Duyuru kaydetme hatası:", error);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// 📌 2. ÖĞRENCİNİN KAYDETTİĞİ DUYURULARI GETİRME API'Sİ
app.get("/saved-announcements/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT a.* FROM announcements a 
       JOIN saved_announcements sa ON a.id = sa.announcement_id 
       WHERE sa.user_id = $1`,
      [userId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Kaydedilen duyurular çekilirken hata:", error);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// --- HOCALAR İÇİN: KENDİ BÖLÜMÜNDEKİ ÖĞRENCİLERİ GETİR (ZIRHLI SÜRÜM) ---
app.get("/teacher-students", async (req, res) => {
  const { department } = req.query;

  console.log("--- ÖĞRENCİ LİSTESİ İSTEĞİ GELDİ ---");
  console.log("Gelen Bölüm Parametresi:", department);

  if (!department || department === "undefined") {
    console.log("🚨 Hata: Bölüm bilgisi boş veya geçersiz geldi!");
    return res.status(400).send("Hocanın bölüm bilgisi sunucuya ulaşmadı.");
  }

  try {
    // DÜZELTME: created_at sütunu silindi, sadece var olan sütunlar çekiliyor
    const query = `
      SELECT id, name, email, department 
      FROM users 
      WHERE role = 'student' AND TRIM(LOWER(department)) = TRIM(LOWER($1))
      ORDER BY name ASC
    `;
    const result = await pool.query(query, [department.trim()]);

    console.log(
      `✅ Başarılı: (${department}) bölümü için ${result.rows.length} öğrenci bulundu.`,
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("🚨 Veritabanı Sorgu Hatası:", err.message);
    res.status(500).send("Veritabanı hatası: " + err.message);
  }
});

// --- ÖĞRENCİNİN KENDİ MESAJLARINI VE GELEN CEVAPLARI GÖRMESİ ---
app.get("/student-feedbacks/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM feedbacks WHERE user_id = $1 ORDER BY created_at DESC",
      [req.params.userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Öğrenci mesajları çekilirken hata:", err);
    res.status(500).send("Mesajlar çekilemedi.");
  }
});

// --- KULÜBÜN GERÇEK ÜYE SAYISINI GETİR ---
app.get("/club-member-count/:clubName", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) as total_members FROM club_members WHERE club_name = $1",
      [req.params.clubName],
    );
    res.json({ total: parseInt(result.rows[0].total_members) });
  } catch (err) {
    console.error("Üye sayısı çekilemedi:", err);
    res.status(500).send("Sunucu hatası.");
  }
});

// --- KULÜBÜN KAYITLI ÜYELERİNİ GETİR ---
app.get("/club-members-list/:clubName", async (req, res) => {
  try {
    // Kulüp üyeleri (club_members) tablosu ile kullanıcılar (users) tablosunu birleştirip isimleri çekiyoruz
    const query = `
      SELECT u.id, u.name, u.email 
      FROM club_members cm 
      JOIN users u ON cm.user_id = u.id 
      WHERE cm.club_name = $1 
      ORDER BY u.name ASC
    `;
    const result = await pool.query(query, [req.params.clubName]);
    res.json(result.rows);
  } catch (err) {
    console.error("Kulüp üyeleri çekilemedi:", err);
    res.status(500).send("Sunucu hatası.");
  }
});
// SUNUCUYU BAŞLAT
const PORT = 5000;
app.listen(PORT, () =>
  console.log(`🚀 Sunucu ${PORT} portunda tıkır tıkır çalışıyor...`),
);
