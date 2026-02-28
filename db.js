const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");

function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function load() {
  ensureDir(dataDir);
  if (!fs.existsSync(dbPath)) {
    const initial = {
      counters: { user: 0, msg: 0, dmThread: 0, dmMsg: 0 },
      users: [],
      messages: [],
      dmThreads: [],
      dmMessages: []
    };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2), "utf-8");
  }
  return JSON.parse(fs.readFileSync(dbPath, "utf-8"));
}

function save(db) {
  const tmp = dbPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf-8");
  fs.renameSync(tmp, dbPath);
}

function init(){ load(); }
function nowIso(){ return new Date().toISOString(); }

// USERS
function createUser(username, passHash) {
  const db = load();
  if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    const err = new Error("username_taken"); err.code = "username_taken"; throw err;
  }
  const id = ++db.counters.user;
  const u = {
    id,
    username,
    pass_hash: passHash,
    avatar_path: null,
    banner_path: null,
    description: "",
    twofa_enabled: 0,
    twofa_secret: null,
    created_at: nowIso()
  };
  db.users.push(u);
  save(db);
  return id;
}

function getUserByUsername(username) {
  const db = load();
  return db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase()) || null;
}

function getUserById(id) {
  const db = load();
  return db.users.find(u => u.id === Number(id)) || null;
}

function updateAvatar(userId, avatarPath) {
  const db = load();
  const u = db.users.find(u => u.id === Number(userId));
  if (!u) return;
  u.avatar_path = avatarPath;
  save(db);
}

function updateBanner(userId, bannerPath) {
  const db = load();
  const u = db.users.find(u => u.id === Number(userId));
  if (!u) return;
  u.banner_path = bannerPath;
  save(db);
}

function updateDescription(userId, description) {
  const db = load();
  const u = db.users.find(u => u.id === Number(userId));
  if (!u) return;
  u.description = String(description || "").slice(0, 280);
  save(db);
}

function updatePassword(userId, passHash) {
  const db = load();
  const u = db.users.find(u => u.id === Number(userId));
  if (!u) return;
  u.pass_hash = passHash;
  save(db);
}

function set2FA(userId, enabled, secretOrNull) {
  const db = load();
  const u = db.users.find(u => u.id === Number(userId));
  if (!u) return;
  u.twofa_enabled = enabled ? 1 : 0;
  u.twofa_secret = enabled ? secretOrNull : null;
  save(db);
}

function searchUsersByUsername(q, limit=12) {
  const db = load();
  const query = String(q || "").trim().toLowerCase();
  if (!query) return [];
  return db.users
    .filter(u => u.username.toLowerCase().includes(query))
    .slice(0, limit)
    .map(u => ({
      id: u.id,
      username: u.username,
      avatar_path: u.avatar_path,
      description: u.description || ""
    }));
}

// GLOBAL MESSAGES
function insertMessage(userId, text, attachment=null) {
  const db = load();
  const id = ++db.counters.msg;
  const created_at = nowIso();
  const msg = { id, user_id: Number(userId), text, created_at, attachment };
  db.messages.push(msg);
  if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
  save(db);
  return msg;
}

function getMessages(limit=60) {
  const db = load();
  const msgs = db.messages.slice(-limit);
  const byId = new Map(db.users.map(u => [u.id, u]));
  return msgs.map(m => {
    const u = byId.get(m.user_id);
    return {
      id: m.id,
      text: m.text,
      created_at: m.created_at,
      username: u?.username || "unknown",
      avatar_path: u?.avatar_path || null,
      user_id: m.user_id,
      attachment: m.attachment || null
    };
  });
}

// DMs
function getOrCreateDMThread(aId, bId) {
  const db = load();
  const a = Number(aId), b = Number(bId);
  const min = Math.min(a,b), max = Math.max(a,b);
  let t = db.dmThreads.find(x => x.a_id === min && x.b_id === max);
  if (!t) {
    const id = ++db.counters.dmThread;
    t = { id, a_id: min, b_id: max, created_at: nowIso() };
    db.dmThreads.push(t);
    save(db);
  }
  return t;
}

function threadHasUser(thread, userId){
  const uid = Number(userId);
  return thread && (thread.a_id === uid || thread.b_id === uid);
}

function getDMThreadById(threadId){
  const db = load();
  return db.dmThreads.find(t => t.id === Number(threadId)) || null;
}

function insertDMMessage(threadId, userId, text, attachment=null) {
  const db = load();
  const id = ++db.counters.dmMsg;
  const created_at = nowIso();
  const msg = { id, thread_id: Number(threadId), user_id: Number(userId), text, created_at, attachment };
  db.dmMessages.push(msg);
  if (db.dmMessages.length > 10000) db.dmMessages = db.dmMessages.slice(-10000);
  save(db);
  return msg;
}

function getDMMessages(threadId, limit=60) {
  const db = load();
  const tid = Number(threadId);
  const all = db.dmMessages.filter(m => m.thread_id === tid);
  const msgs = all.slice(-limit);
  const byId = new Map(db.users.map(u => [u.id, u]));
  return msgs.map(m => {
    const u = byId.get(m.user_id);
    return {
      id: m.id,
      thread_id: String(m.thread_id),
      text: m.text,
      created_at: m.created_at,
      username: u?.username || "unknown",
      avatar_path: u?.avatar_path || null,
      user_id: m.user_id,
      attachment: m.attachment || null
    };
  });
}

function listDMThreadsForUser(userId, limit=50){
  const db = load();
  const uid = Number(userId);
  const byId = new Map(db.users.map(u => [u.id, u]));
  const threads = db.dmThreads
    .filter(t => t.a_id === uid || t.b_id === uid)
    .map(t => {
      const peerId = (t.a_id === uid) ? t.b_id : t.a_id;
      const peer = byId.get(peerId);
      // last message
      const last = [...db.dmMessages].reverse().find(m => m.thread_id === t.id) || null;
      return {
        id: String(t.id),
        peer: peer ? { id: peer.id, username: peer.username, avatar_path: peer.avatar_path, description: peer.description || "" } : { id: peerId, username: "unknown", avatar_path: null, description: "" },
        last: last ? { text: last.text, created_at: last.created_at, attachment: last.attachment || null } : null,
        created_at: t.created_at
      };
    });
  threads.sort((a,b) => {
    const at = a.last?.created_at || a.created_at;
    const bt = b.last?.created_at || b.created_at;
    return bt.localeCompare(at);
  });
  return threads.slice(0, limit);
}

module.exports = {
  init,
  createUser,
  getUserByUsername,
  getUserById,
  updateAvatar,
  updateBanner,
  updateDescription,
  updatePassword,
  set2FA,
  searchUsersByUsername,
  insertMessage,
  getMessages,
  getOrCreateDMThread,
  getDMThreadById,
  threadHasUser,
  insertDMMessage,
  getDMMessages,
  listDMThreadsForUser
};
