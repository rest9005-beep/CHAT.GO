(() => {
  const el = (id) => document.getElementById(id);
  const messagesEl = el("messages");
  const form = el("composer");
  const textEl = el("text");
  const statusEl = el("status");
  const typingEl = document.getElementById("typing");
  const me = window.__ME__;

  const fileInput = el("file");
  const sendFileBtn = el("sendFileBtn");
  const recBtn = el("recBtn");

  function esc(s){
    return (s ?? "").toString().replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function attachmentHtml(att){
    if (!att) return "";
    const mime = att.mime || "";
    const url = att.url;
    const name = att.name || "file";
    if (/^image\//i.test(mime)) {
      return `<div class="attach"><img src="${esc(url)}" alt="${esc(name)}"></div>`;
    }
    if (/^audio\//i.test(mime)) {
      return `<div class="attach"><audio controls src="${esc(url)}"></audio></div>`;
    }
    return `<div class="attach"><div class="file">
      <span class="pill">Файл</span>
      <div>
        <div class="name">${esc(name)}</div>
        <div class="small">${esc((att.size_kb||0) + " KB")} · <a href="${esc(url)}" download>скачать</a></div>
      </div>
    </div></div>`;
  }

  function renderMsg(m){
    const d = new Date(m.created_at);
    const time = d.toLocaleString(undefined, {hour:"2-digit", minute:"2-digit", day:"2-digit", month:"2-digit"});
    const ava = m.avatar_path || "/default-avatar.svg";
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `
      <div class="msgRow">
        <a class="msgAvatar" href="/dm/${encodeURIComponent(m.username)}" title="Написать в ЛС">
          <img src="${esc(ava)}" alt="ava">
        </a>
        <div class="msgBubble">
          <div class="meta">
            <span><a href="/dm/${encodeURIComponent(m.username)}">${esc(m.username)}</a></span>
            <span>${esc(time)}</span>
          </div>
          <div class="text">${esc(m.text || "")}</div>
          ${attachmentHtml(m.attachment)}
        </div>
      </div>
    `;
    messagesEl.appendChild(div);
  }

  async function loadHistory(){
    const r = await fetch("/api/messages?limit=80");
    const data = await r.json();
    messagesEl.innerHTML = "";
    data.messages.forEach(renderMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const socket = io({ transports: ["websocket","polling"] });

  socket.on("connect", () => {
    statusEl.textContent = "online";
    statusEl.className = "badge";
    socket.emit("join", { room: "global" });
    loadHistory();
  });

  socket.on("disconnect", () => {
    statusEl.textContent = "offline";
    statusEl.className = "badge";
  });

  socket.on("msg:new", (m) => {
    renderMsg(m);
    const nearBottom = (messagesEl.scrollHeight - (messagesEl.scrollTop + messagesEl.clientHeight)) < 120;
    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  let typingTimer = null;
  textEl.addEventListener("input", () => {
    socket.emit("typing", { room: "global", isTyping: textEl.value.trim().length > 0 });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(()=>socket.emit("typing", { room:"global", isTyping:false }), 800);
  });

  socket.on("typing", (payload) => {
    const { username, isTyping, room } = payload || {};
    if (room !== "global") return;
    if (!username || username === me.username) return;
    if (typingEl) typingEl.textContent = isTyping ? `${username} печатает…` : "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = textEl.value.trim();
    if (!text) return;
    textEl.value = "";
    socket.emit("typing", { room:"global", isTyping:false });
    await fetch("/api/messages", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ text })
    });
    textEl.focus();
  });

  textEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") form.requestSubmit();
  });

  sendFileBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = "";
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) { alert("Не удалось загрузить файл"); return; }
    const data = await r.json();
    await fetch("/api/messages", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ text: "", attachment: data.attachment })
    });
  });

  let mediaRecorder = null;
  let chunks = [];
  let recording = false;

  async function startRec(){
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      stream.getTracks().forEach(t=>t.stop());
      const file = new File([blob], `voice_${Date.now()}.webm`, { type: blob.type });
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/upload", { method:"POST", body: fd });
      if (!r.ok) { alert("Не удалось отправить голосовое"); return; }
      const data = await r.json();
      await fetch("/api/messages", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ text: "", attachment: data.attachment })
      });
    };
    mediaRecorder.start();
    recording = true;
    recBtn.textContent = "Стоп 🎙️";
    recBtn.classList.add("danger");
  }

  function stopRec(){
    if (!mediaRecorder) return;
    mediaRecorder.stop();
    recording = false;
    recBtn.textContent = "Голосовое";
    recBtn.classList.remove("danger");
  }

  recBtn?.addEventListener("click", async () => {
    try {
      if (!recording) await startRec();
      else stopRec();
    } catch (e) {
      alert("Нужен доступ к микрофону");
    }
  });
})();
