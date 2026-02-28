require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");

const express = require("express");
const expressLayouts = require("express-ejs-layouts");
const helmet = require("helmet");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const QRCode = require("qrcode");
const speakeasy = require("speakeasy");
const { Server } = require("socket.io");

const {
  init,
  getUserById,
  getUserByUsername,
  createUser,
  updateAvatar,
  updateBanner,
  updateDescription,
  updatePassword,
  set2FA,
  searchUsersByUsername,
  insertMessage,
  getMessages,
  getOrCreateDMThread,
  insertDMMessage,
  getDMMessages
} = require("./db");

init();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(cookieParser());

const FileStore = require("session-file-store")(session);
const sessionSecret = process.env.SESSION_SECRET || "dev-only-change-me";

const sessionMiddleware = session({
  store: new FileStore({
    path: path.join(__dirname, "data", "sessions"),
    retries: 1,
    ttl: 60 * 60 * 24 * 7
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 }
});
app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// Censorship (basic)
const BAD_WORDS = [
  "бля","блять","сука","пизд","хуй","хуе","еба","ёба","ебу","ебл","ёб","пидор","пидр","мудак","гандон",
  "fuck","shit","bitch","cunt","asshole","dick"
].map(w => w.toLowerCase());

function censorText(input) {
  let s = String(input ?? "");
  for (const w of BAD_WORDS) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    s = s.replace(re, "****");
  }
  return s;
}

// Uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase().slice(0, 12);
    cb(null, `${req.session.userId || "anon"}_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => cb(null, true)
});

function setFlash(req, type, message) { req.session.flash = { type, message }; }
function consumeFlash(req) { const f = req.session.flash; delete req.session.flash; return f || null; }

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  const u = getUserById(req.session.userId);
  if (!u) { req.session.destroy(()=>{}); return res.redirect("/login"); }
  res.locals.user = u; next();
}
function require2FAPending(req, res, next) { if (!req.session.pending2FA) return res.redirect("/login"); next(); }

function render(req, res, view, params = {}) {
  const user = req.session.userId ? getUserById(req.session.userId) : null;
  res.render(view, { ...params, user, flash: consumeFlash(req), title: params.title || "CHAT.GO", activeTab: params.activeTab || "" });
}

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;

// Pages
app.get("/", (req, res) => render(req, res, "home", { title: "Главная" }));

app.get("/register", (req, res) => render(req, res, "register", { title: "Регистрация" }));
app.post("/register", authLimiter, (req, res) => {
  const username = (req.body.username || "").trim();
  const password = (req.body.password || "");
  if (!USERNAME_RE.test(username)) { setFlash(req, "err", "Username: 3–20 символов, только латиница/цифры/._"); return res.redirect("/register"); }
  if (password.length < 8) { setFlash(req, "err", "Пароль минимум 8 символов."); return res.redirect("/register"); }
  if (getUserByUsername(username)) { setFlash(req, "err", "Этот username уже занят."); return res.redirect("/register"); }
  const id = createUser(username, bcrypt.hashSync(password, 12));
  req.session.userId = id;
  setFlash(req, "ok", "Аккаунт создан. Добро пожаловать в CHAT.GO!");
  res.redirect("/chat");
});

app.get("/login", (req, res) => render(req, res, "login", { title: "Вход" }));
app.post("/login", authLimiter, (req, res) => {
  const username = (req.body.username || "").trim();
  const password = (req.body.password || "");
  const u = getUserByUsername(username);
  if (!u) { setFlash(req, "err", "Неверный username или пароль."); return res.redirect("/login"); }
  if (!bcrypt.compareSync(password, u.pass_hash)) { setFlash(req, "err", "Неверный username или пароль."); return res.redirect("/login"); }

  if (u.twofa_enabled) {
    req.session.pending2FA = { userId: u.id, ts: Date.now() };
    setFlash(req, "ok", "Пароль верный. Введите код 2FA.");
    return res.redirect("/2fa");
  }

  req.session.userId = u.id;
  setFlash(req, "ok", "Вы вошли.");
  res.redirect("/chat");
});

app.get("/2fa", require2FAPending, (req, res) => render(req, res, "twofa", { title: "2FA" }));
app.post("/2fa", require2FAPending, (req, res) => {
  const token = (req.body.token || "").trim();
  const pending = req.session.pending2FA;
  if (!pending || (Date.now() - pending.ts) > 5 * 60 * 1000) {
    req.session.pending2FA = null;
    setFlash(req, "err", "Сессия 2FA истекла. Войдите снова.");
    return res.redirect("/login");
  }
  const u = getUserById(pending.userId);
  const verified = speakeasy.totp.verify({ secret: u.twofa_secret, encoding: "base32", token, window: 1 });
  if (!verified) { setFlash(req, "err", "Неверный код."); return res.redirect("/2fa"); }
  req.session.userId = u.id;
  req.session.pending2FA = null;
  setFlash(req, "ok", "2FA подтверждена. Вы вошли.");
  res.redirect("/chat");
});

app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

app.get("/chat", requireAuth, (req, res) => res.render("chat", { title: "Чат", user: res.locals.user, flash: consumeFlash(req) }));

app.get("/dms", requireAuth, (req, res) => {
  const { listDMThreadsForUser } = require("./db");
  const threads = listDMThreadsForUser(req.session.userId, 80);
  res.render("dms", { title: "Личные чаты", user: res.locals.user, threads, flash: consumeFlash(req), activeTab: "dms" });
});

app.get("/search", requireAuth, (req, res) => {
  res.render("search", { title: "Поиск", user: res.locals.user, flash: consumeFlash(req), activeTab: "search" });
});

app.get("/settings", requireAuth, (req, res) => res.render("settings", { title: "Профиль", user: res.locals.user, flash: consumeFlash(req) }));

app.post("/settings/description", requireAuth, (req, res) => {
  updateDescription(req.session.userId, censorText(req.body.description || ""));
  setFlash(req, "ok", "Описание сохранено.");
  res.redirect("/settings");
});

app.post("/settings/avatar", requireAuth, upload.single("avatar"), (req, res) => {
  updateAvatar(req.session.userId, `/uploads/${req.file.filename}`);
  setFlash(req, "ok", "Аватар обновлён.");
  res.redirect("/settings");
});
app.get("/settings/avatar/remove", requireAuth, (req, res) => {
  updateAvatar(req.session.userId, null);
  setFlash(req, "ok", "Аватар убран.");
  res.redirect("/settings");
});

app.post("/settings/banner", requireAuth, upload.single("banner"), (req, res) => {
  updateBanner(req.session.userId, `/uploads/${req.file.filename}`);
  setFlash(req, "ok", "Шапка обновлена.");
  res.redirect("/settings");
});
app.get("/settings/banner/remove", requireAuth, (req, res) => {
  updateBanner(req.session.userId, null);
  setFlash(req, "ok", "Шапка убрана.");
  res.redirect("/settings");
});

app.get("/security", requireAuth, async (req, res) => {
  const user = res.locals.user;
  let secret = null, qrDataUrl = null;
  if (!user.twofa_enabled) {
    const s = speakeasy.generateSecret({ length: 20, name: `CHAT.GO (${user.username})` });
    secret = s.base32;
    qrDataUrl = await QRCode.toDataURL(s.otpauth_url, { margin: 1, scale: 6 });
  }
  res.render("security", { title: "Безопасность", user, flash: consumeFlash(req), secret, qrDataUrl });
});

app.post("/security/password", requireAuth, (req, res) => {
  const currentPassword = req.body.currentPassword || "";
  const newPassword = req.body.newPassword || "";
  if (newPassword.length < 8) { setFlash(req, "err", "Новый пароль минимум 8 символов."); return res.redirect("/security"); }
  const user = getUserById(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.pass_hash)) { setFlash(req, "err", "Текущий пароль неверный."); return res.redirect("/security"); }
  updatePassword(user.id, bcrypt.hashSync(newPassword, 12));
  setFlash(req, "ok", "Пароль обновлён.");
  res.redirect("/security");
});

app.post("/security/2fa/enable", requireAuth, (req, res) => {
  const secret = (req.body.secret || "").trim();
  const token = (req.body.token || "").trim();
  const verified = speakeasy.totp.verify({ secret, encoding: "base32", token, window: 1 });
  if (!verified) { setFlash(req, "err", "Код не подошёл. Проверь время на телефоне и попробуй снова."); return res.redirect("/security"); }
  set2FA(req.session.userId, true, secret);
  setFlash(req, "ok", "2FA включена.");
  res.redirect("/security");
});

app.post("/security/2fa/disable", requireAuth, (req, res) => {
  const token = (req.body.token || "").trim();
  const user = getUserById(req.session.userId);
  const verified = speakeasy.totp.verify({ secret: user.twofa_secret, encoding: "base32", token, window: 1 });
  if (!verified) { setFlash(req, "err", "Неверный код."); return res.redirect("/security"); }
  set2FA(req.session.userId, false, null);
  setFlash(req, "ok", "2FA отключена.");
  res.redirect("/security");
});

// DM
app.get("/dm/:username", requireAuth, (req, res) => {
  const peer = getUserByUsername(String(req.params.username || ""));
  if (!peer) { setFlash(req, "err", "Пользователь не найден."); return res.redirect("/chat"); }
  if (peer.id === req.session.userId) { setFlash(req, "err", "Нельзя написать самому себе 🙂"); return res.redirect("/chat"); }
  const thread = getOrCreateDMThread(req.session.userId, peer.id);
  res.render("dm", { title: "ЛС", user: res.locals.user, peer, threadId: thread.id, flash: consumeFlash(req), activeTab: "dms" });
});

// API
app.get("/api/users/search", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim();
  const users = searchUsersByUsername(q, 15).filter(u => u.id !== req.session.userId);
  res.json({ users });
});

app.post("/api/upload", requireAuth, upload.single("file"), (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: "no_file" });
  res.json({
    attachment: {
      url: `/uploads/${f.filename}`,
      name: f.originalname,
      mime: f.mimetype,
      size_kb: Math.round((f.size || 0) / 1024)
    }
  });
});

app.get("/api/messages", requireAuth, (req, res) => {
  const limit = Math.max(10, Math.min(200, parseInt(req.query.limit || "60", 10)));
  res.json({ messages: getMessages(limit) });
});

app.post("/api/messages", requireAuth, (req, res) => {
  const text = censorText((req.body.text || "").toString().trim());
  const attachment = req.body.attachment || null;
  if (!text && !attachment) return res.status(400).json({ error: "empty" });
  if (text.length > 1200) return res.status(400).json({ error: "too_long" });

  const m = insertMessage(req.session.userId, text, attachment);
  const u = getUserById(req.session.userId);
  const payload = { id: m.id, text: m.text, created_at: m.created_at, username: u.username, avatar_path: u.avatar_path || null, user_id: u.id, attachment: m.attachment || null };
  io.to("global").emit("msg:new", payload);
  res.json({ ok: true });
});

app.get("/api/dm/:threadId/messages", requireAuth, (req, res) => {
  const limit = Math.max(10, Math.min(200, parseInt(req.query.limit || "60", 10)));
  res.json({ messages: getDMMessages(req.params.threadId, limit) });
});

app.post("/api/dm/:threadId/messages", requireAuth, (req, res) => {
  const text = censorText((req.body.text || "").toString().trim());
  const attachment = req.body.attachment || null;
  if (!text && !attachment) return res.status(400).json({ error: "empty" });
  if (text.length > 1200) return res.status(400).json({ error: "too_long" });

  const m = insertDMMessage(req.params.threadId, req.session.userId, text, attachment);
  const u = getUserById(req.session.userId);
  const payload = { id: m.id, thread_id: String(req.params.threadId), text: m.text, created_at: m.created_at, username: u.username, avatar_path: u.avatar_path || null, user_id: u.id, attachment: m.attachment || null };
  io.to(`dm:${req.params.threadId}`).emit("dm:new", payload);
  res.json({ ok: true });
});

// Socket.IO
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
io.on("connection", (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) return socket.disconnect(true);
  const u = getUserById(userId);
  if (!u) return socket.disconnect(true);

  socket.on("join", (payload) => {
    const room = String(payload?.room || "");
    if (!room) return;
    if (room === "global" || room.startsWith("dm:")) socket.join(room);
  });

  socket.on("typing", (payload) => {
    const room = String(payload?.room || "global");
    socket.to(room).emit("typing", { username: u.username, isTyping: !!payload?.isTyping, room });
  });
});

app.use((err, req, res, _next) => {
  console.error(err);
  setFlash(req, "err", err.message || "Ошибка");
  res.redirect("back");
});

const PORT = parseInt(process.env.PORT || "3000", 10);
server.listen(PORT, () => console.log(`CHAT.GO running: http://localhost:${PORT}`));
