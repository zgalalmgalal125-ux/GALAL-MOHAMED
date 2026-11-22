require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "EgyptBaccalaureateNews/1.0" }
});

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "news.json");
const REFRESH_MINUTES = Math.max(5, Number(process.env.NEWS_REFRESH_MINUTES || 15));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 14) {
  console.warn("تحذير: عيّن ADMIN_PASSWORD بطول 14 حرفًا على الأقل قبل النشر.");
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  }
}));
app.use(express.json({ limit: "40kb" }));
app.use(express.static(path.join(__dirname, "public")));

const categories = [
  { name: "أخبار البكالوريا", query: "البكالوريا المصرية" },
  { name: "قرارات الوزارة", query: "وزارة التربية والتعليم مصر قرارات" },
  { name: "الامتحانات", query: "امتحانات البكالوريا المصرية" },
  { name: "التعليم الثانوي", query: "التعليم الثانوي مصر" }
];

let news = [];
let lastUpdated = null;
let lastError = null;
let isRefreshing = false;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      news = Array.isArray(parsed.news) ? parsed.news : [];
      lastUpdated = parsed.lastUpdated || null;
    }
  } catch (error) {
    console.error("تعذر قراءة ملف الأخبار:", error.message);
  }
}

function saveData() {
  ensureDataDir();
  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify({ news, lastUpdated }, null, 2), "utf8");
  fs.renameSync(tempFile, DATA_FILE);
}

function cleanText(value, max = 500) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function makeId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 18);
}

async function refreshNews() {
  if (isRefreshing) return;
  isRefreshing = true;
  let collected = [];

  try {
    for (const category of categories) {
      try {
        const params = new URLSearchParams({
          q: category.query,
          hl: "ar",
          gl: "EG",
          ceid: "EG:ar"
        });
        const feed = await parser.parseURL(
          "https://news.google.com/rss/search?" + params.toString()
        );

        for (const item of (feed.items || [])) {
          const link = safeHttpUrl(item.link);
          const title = cleanText(item.title, 300);
          if (!link || !title) continue;

          collected.push({
            id: makeId(link),
            title,
            link,
            description: cleanText(item.contentSnippet || item.content || "", 700),
            category: category.name,
            source: cleanText(item.creator || feed.title || "مصدر إخباري", 120),
            date: item.isoDate || item.pubDate || null,
            type: "aggregated",
            verified: false,
            pinned: false
          });
        }
      } catch (error) {
        console.error("RSS error:", category.name, error.message);
      }
    }

    const byId = new Map(news.map(item => [item.id, item]));
    for (const item of collected) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }

    // احتفظ بالأخبار اليدوية، وبآخر 500 خبر مجمّع لتجنب تضخم الملف.
    const manual = Array.from(byId.values()).filter(item => item.type === "manual");
    const aggregated = Array.from(byId.values())
      .filter(item => item.type !== "manual")
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 500);

    news = [...manual, ...aggregated].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.date || 0) - new Date(a.date || 0);
    });

    lastUpdated = new Date().toISOString();
    lastError = null;
    saveData();
  } catch (error) {
    lastError = error.message;
    console.error("تعذر تحديث الأخبار:", error.message);
  } finally {
    isRefreshing = false;
  }
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "محاولات كثيرة. حاول بعد 15 دقيقة." }
});

function requireAdmin(req, res, next) {
  const supplied = req.get("x-admin-password") || "";
  if (!ADMIN_PASSWORD || !safeCompare(supplied, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "كلمة مرور الإدارة غير صحيحة." });
  }
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "egypt-baccalaureate-news" });
});

app.get("/api/news", (req, res) => {
  const category = cleanText(req.query.category, 80);
  const search = cleanText(req.query.search, 120).toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));

  let result = news;
  if (category && category !== "الكل") {
    result = result.filter(item => item.category === category);
  }
  if (search) {
    result = result.filter(item =>
      (item.title + " " + item.description + " " + item.source)
        .toLowerCase().includes(search)
    );
  }

  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    count: result.length,
    lastUpdated,
    refreshing: isRefreshing,
    news: result.slice(0, limit)
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    online: true,
    lastUpdated,
    refreshing: isRefreshing,
    lastError,
    refreshMinutes: REFRESH_MINUTES
  });
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  const password = String(req.body.password || "");
  if (!ADMIN_PASSWORD || !safeCompare(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "كلمة المرور غير صحيحة." });
  }
  res.json({ success: true, message: "تم التحقق. استخدم كلمة المرور في لوحة الإدارة." });
});

app.get("/api/admin/news", requireAdmin, (req, res) => {
  res.json({ news: news.filter(item => item.type === "manual") });
});

app.post("/api/admin/news", requireAdmin, (req, res) => {
  const title = cleanText(req.body.title, 220);
  const description = cleanText(req.body.description, 1000);
  const link = safeHttpUrl(req.body.link);
  const category = categories.some(item => item.name === req.body.category)
    ? req.body.category : "أخبار البكالوريا";

  if (title.length < 5 || !link) {
    return res.status(400).json({ error: "أدخل عنوانًا صحيحًا ورابطًا يبدأ بـ https:// أو http://." });
  }

  const item = {
    id: crypto.randomUUID(),
    title,
    description,
    link,
    category,
    source: cleanText(req.body.source || "إدارة الموقع", 120),
    date: new Date().toISOString(),
    type: "manual",
    verified: req.body.verified === true,
    pinned: false
  };

  news.unshift(item);
  saveData();
  res.status(201).json({ success: true, item });
});

app.patch("/api/admin/news/:id", requireAdmin, (req, res) => {
  const item = news.find(entry => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: "الخبر غير موجود." });

  if (typeof req.body.pinned === "boolean") item.pinned = req.body.pinned;
  if (typeof req.body.verified === "boolean") item.verified = req.body.verified;
  saveData();
  res.json({ success: true, item });
});

app.delete("/api/admin/news/:id", requireAdmin, (req, res) => {
  const before = news.length;
  news = news.filter(item => !(item.id === req.params.id && item.type === "manual"));
  if (news.length === before) {
    return res.status(404).json({ error: "لم يتم العثور على خبر يدوي بهذا المعرّف." });
  }
  saveData();
  res.json({ success: true });
});

app.post("/api/admin/refresh", requireAdmin, async (req, res) => {
  refreshNews();
  res.json({ success: true, message: "بدأ تحديث الأخبار في الخلفية." });
});

loadData();
refreshNews();
setInterval(refreshNews, REFRESH_MINUTES * 60 * 1000);

app.listen(PORT, () => {
  console.log(`أخبار البكالوريا المصرية تعمل على http://localhost:${PORT}`);
});
