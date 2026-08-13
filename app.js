// Shim: replicates the Claude-artifact window.storage API using localStorage,
// so the app works as a normal standalone PWA outside Claude.
window.storage = {
  async get(key, shared = false) {
    const raw = localStorage.getItem("rotina:" + key);
    if (raw === null) throw new Error("not found");
    return { key, value: raw, shared };
  },
  async set(key, value, shared = false) {
    localStorage.setItem("rotina:" + key, value);
    return { key, value, shared };
  },
  async delete(key, shared = false) {
    localStorage.removeItem("rotina:" + key);
    return { key, deleted: true, shared };
  },
  async list(prefix = "", shared = false) {
    const keys = Object.keys(localStorage)
      .filter((k) => k.startsWith("rotina:" + prefix))
      .map((k) => k.replace("rotina:", ""));
    return { keys, prefix, shared };
  },
};

const { useState, useEffect, useRef, useCallback } = React;

const CATEGORIES = {
  Leitura: { color: "#7FE0C1", dim: "#0f3d31" },
  Ligacoes: { color: "#FF9F4A", dim: "#3d2308" },
  Vendas: { color: "#F5C400", dim: "#4a3f00" },
  Estudo: { color: "#5FB8FF", dim: "#0a2c4a" },
  Trabalho: { color: "#FFE066", dim: "#3f3900" },
  DesenvPessoal: { color: "#D48CFF", dim: "#2c0f4a" },
  Saude: { color: "#FF6B4A", dim: "#4a1c0f" },
  Descanso: { color: "#8C8C8C", dim: "#2a2a2a" },
};
const CAT_KEYS = Object.keys(CATEGORIES);
const CAT_LABEL = {
  Leitura: "Leitura", Ligacoes: "Ligações a leads", Vendas: "Vendas",
  Estudo: "Aulas / Estudo", Trabalho: "Trabalho", DesenvPessoal: "Desenv. pessoal",
  Saude: "Saúde", Descanso: "Descanso",
};

function todayKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function toMin(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
function fromMin(min) {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60).toString().padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}
function fmtDur(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h <= 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${m.toString().padStart(2, "0")}`;
}
function uid() { return Math.random().toString(36).slice(2, 10); }

const DEFAULT_TEMPLATE = [
  { start: "07:00", end: "07:15", activity: "Acordar + rotina matinal", category: "Saude" },
  { start: "07:15", end: "08:00", activity: "Leitura", category: "Leitura" },
  { start: "08:00", end: "08:30", activity: "Pequeno-almoço + plano do dia", category: "Trabalho" },
  { start: "08:30", end: "10:00", activity: "Ligações a leads / follow-up WhatsApp", category: "Ligacoes" },
  { start: "10:00", end: "12:30", activity: "Bloco de vendas — criativos, ads, funis", category: "Vendas" },
  { start: "12:30", end: "13:30", activity: "Almoço", category: "Descanso" },
  { start: "13:30", end: "15:00", activity: "Aulas / estudo (copy, tráfego, automação)", category: "Estudo" },
  { start: "15:00", end: "17:30", activity: "Execução — automação, entrega, otimização", category: "Trabalho" },
  { start: "17:30", end: "18:30", activity: "Ligações a leads — 2ª ronda", category: "Ligacoes" },
  { start: "18:30", end: "19:30", activity: "Desenvolvimento pessoal / exercício", category: "DesenvPessoal" },
  { start: "19:30", end: "20:30", activity: "Jantar", category: "Descanso" },
  { start: "20:30", end: "21:30", activity: "Leitura", category: "Leitura" },
  { start: "21:30", end: "22:15", activity: "Revisão do dia + plano de amanhã", category: "Trabalho" },
  { start: "23:00", end: "23:15", activity: "Dormir", category: "Descanso" },
];

function withIds(list) { return list.map((b) => ({ id: uid(), status: "pending", ...b })); }

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "square"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.start(); o.stop(ctx.currentTime + 0.35);
  } catch {}
}

function App() {
  const [dateKey, setDateKey] = useState(todayKey());
  const [blocks, setBlocks] = useState(null);
  const [now, setNow] = useState(new Date());
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ start: "", end: "", activity: "", category: "Trabalho" });
  const [error, setError] = useState("");
  const [flash, setFlash] = useState(false);
  const [notifOn, setNotifOn] = useState(false);
  const [savedTemplate, setSavedTemplate] = useState(false);
  const scrollRef = useRef(null);
  const activeIdRef = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      setNotifOn(true);
    }
  }, []);

  function askNotif() {
    try {
      if ("Notification" in window) {
        Notification.requestPermission().then((p) => setNotifOn(p === "granted"));
      }
    } catch {}
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setBlocks(null);
      try {
        const res = await window.storage.get(`day:${dateKey}`, false);
        if (!cancelled) { setBlocks(JSON.parse(res.value)); return; }
      } catch {}
      try {
        const tpl = await window.storage.get("template", false);
        if (!cancelled) setBlocks(withIds(JSON.parse(tpl.value)));
      } catch {
        if (!cancelled) setBlocks(withIds(DEFAULT_TEMPLATE));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [dateKey]);

  const persist = useCallback(async (next) => {
    setBlocks(next);
    try { await window.storage.set(`day:${dateKey}`, JSON.stringify(next), false); }
    catch { setError("Falha ao guardar. Os dados podem não persistir."); }
  }, [dateKey]);

  const sorted = blocks ? [...blocks].sort((a, b) => toMin(a.start) - toMin(b.start)) : [];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isToday = dateKey === todayKey();

  const activeBlock = isToday ? sorted.find((b) => toMin(b.start) <= nowMin && nowMin < toMin(b.end)) : null;
  const nextBlock = isToday ? sorted.find((b) => toMin(b.start) > nowMin) : null;

  useEffect(() => {
    if (!isToday) return;
    const currentId = activeBlock ? activeBlock.id : null;
    if (activeIdRef.current !== null && activeIdRef.current !== currentId) {
      setFlash(true);
      beep();
      if (notifOn && activeBlock) {
        try { new Notification("Rotina.OS", { body: `Agora: ${activeBlock.activity}` }); } catch {}
      }
      setTimeout(() => setFlash(false), 1800);
    }
    activeIdRef.current = currentId;
  }, [activeBlock ? activeBlock.id : null, isToday]);

  if (blocks === null) {
    return React.createElement("div", { style: { background: "#0A0A0A", minHeight: 500, display: "flex", alignItems: "center", justifyContent: "center", color: "#F5C400", fontFamily: "monospace" } }, "A carregar...");
  }

  const dayStart = sorted.length ? Math.min(...sorted.map((b) => toMin(b.start))) - 30 : 360;
  const dayEnd = sorted.length ? Math.max(...sorted.map((b) => toMin(b.end))) + 30 : 1380;
  const span = Math.max(dayEnd - dayStart, 60);
  const PX_PER_MIN = 1.5;
  const totalHeight = span * PX_PER_MIN;
  const nowTop = (nowMin - dayStart) * PX_PER_MIN;

  const plannedTotal = sorted.reduce((s, b) => s + (toMin(b.end) - toMin(b.start)), 0);
  const doneTotal = sorted.filter((b) => b.status === "done").reduce((s, b) => s + (toMin(b.end) - toMin(b.start)), 0);
  const skippedTotal = sorted.filter((b) => b.status === "skipped").reduce((s, b) => s + (toMin(b.end) - toMin(b.start)), 0);
  const decidedTotal = sorted.filter((b) => b.status !== "pending").reduce((s, b) => s + (toMin(b.end) - toMin(b.start)), 0);
  const score = decidedTotal > 0 ? Math.round((doneTotal / decidedTotal) * 100) : null;
  const scoreDisplay = plannedTotal > 0 ? Math.round((doneTotal / plannedTotal) * 100) : 0;

  function cycleStatus(id) {
    const order = ["pending", "done", "skipped"];
    persist(sorted.map((b) => b.id === id ? { ...b, status: order[(order.indexOf(b.status) + 1) % order.length] } : b));
  }
  function removeBlock(id) { persist(sorted.filter((b) => b.id !== id)); }
  function addBlock(e) {
    e.preventDefault();
    if (!form.start || !form.end || !form.activity.trim()) return;
    if (toMin(form.end) <= toMin(form.start)) { setError("Hora de fim deve ser depois da hora de início."); return; }
    setError("");
    persist([...sorted, { id: uid(), ...form, status: "pending" }]);
    setForm({ start: "", end: "", activity: "", category: "Trabalho" });
    setShowForm(false);
  }
  async function saveAsTemplate() {
    try {
      const tpl = sorted.map(({ start, end, activity, category }) => ({ start, end, activity, category }));
      await window.storage.set("template", JSON.stringify(tpl), false);
      setSavedTemplate(true);
      setTimeout(() => setSavedTemplate(false), 2200);
    } catch { setError("Falha ao guardar modelo."); }
  }
  const changeDay = (offset) => {
    const d = new Date(dateKey); d.setDate(d.getDate() + offset);
    setDateKey(d.toISOString().slice(0, 10));
  };

  const hourMarks = [];
  for (let m = Math.ceil(dayStart / 60) * 60; m <= dayEnd; m += 60) hourMarks.push(m);

  const activeCat = activeBlock ? CATEGORIES[activeBlock.category] : null;
  const minutesLeft = activeBlock ? toMin(activeBlock.end) - nowMin : 0;
  const blockLen = activeBlock ? toMin(activeBlock.end) - toMin(activeBlock.start) : 1;
  const blockElapsed = activeBlock ? nowMin - toMin(activeBlock.start) : 0;
  const untilNext = nextBlock ? toMin(nextBlock.start) - nowMin : null;

  const navBtn = { height: 32, minWidth: 32, borderRadius: 5, background: "#141414", border: "1px solid #2a2a2a", color: "#F5C400", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
  const tinyBtn = { border: "none", borderRadius: 4, padding: "4px 8px", fontSize: 10, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.3 };
  const inputStyle = { background: "#0A0A0A", border: "1px solid #2a2a2a", borderRadius: 5, padding: "8px 10px", color: "#F4F0E6", fontSize: 13, outline: "none" };

  const e = React.createElement;

  return e("div", { style: { background: "#0A0A0A", color: "#F4F0E6", minHeight: "100vh", fontFamily: "'Inter', system-ui, sans-serif", position: "relative" } },
    e("div", { style: { padding: "20px 20px 14px", borderBottom: "1px solid #1f1f1f" } },
      e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 } },
        e("div", null,
          e("div", { style: { fontFamily: "'Archivo Black', sans-serif", fontSize: 22, letterSpacing: "-0.5px", color: "#F5C400", lineHeight: 1 } },
            "ROTINA", e("span", { style: { color: "#F4F0E6" } }, ".OS")),
          e("div", { style: { fontSize: 11, color: "#8C8C8C", marginTop: 6, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: 1 } },
            new Date(dateKey + "T00:00:00").toLocaleDateString("pt-PT", { weekday: "long", day: "2-digit", month: "long" }))
        ),
        e("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
          !notifOn && e("button", { className: "rt-btn", onClick: askNotif, style: { ...navBtn, width: "auto", padding: "0 10px", fontSize: 10, letterSpacing: 0.5 }, title: "Ativar notificações de transição" }, "🔔 ativar"),
          e("button", { className: "rt-btn", onClick: () => changeDay(-1), style: navBtn }, "‹"),
          e("button", { className: "rt-btn", onClick: () => setDateKey(todayKey()), style: { ...navBtn, width: "auto", padding: "0 14px", fontSize: 11, letterSpacing: 1, fontFamily: "'JetBrains Mono', monospace" } }, "HOJE"),
          e("button", { className: "rt-btn", onClick: () => changeDay(1), style: navBtn }, "›")
        )
      )
    ),

    e("div", { style: { margin: "16px 20px 0", position: "relative", overflow: "hidden", borderRadius: 10, animation: flash ? "flash-bg 1.8s ease" : "none" } },
      isToday && activeBlock ? e("div", { style: { background: "#141414", border: `1px solid ${activeCat.color}`, borderLeft: `5px solid ${activeCat.color}`, borderRadius: 10, padding: 16 } },
        e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
          e("div", { style: { fontSize: 10, letterSpacing: 1.5, color: activeCat.color, fontFamily: "'JetBrains Mono', monospace", display: "flex", alignItems: "center", gap: 6 } },
            e("span", { style: { width: 6, height: 6, borderRadius: "50%", background: activeCat.color, animation: "pulse-dot 1.4s infinite", display: "inline-block" } }),
            `AGORA · ${CAT_LABEL[activeBlock.category]}`),
          e("div", { style: { fontSize: 11, color: "#8C8C8C", fontFamily: "'JetBrains Mono', monospace" } }, fromMin(nowMin))
        ),
        e("div", { style: { fontSize: 20, fontWeight: 700, color: "#F4F0E6", marginBottom: 10, lineHeight: 1.2 } }, activeBlock.activity),
        e("div", { style: { height: 6, background: "#0A0A0A", borderRadius: 3, overflow: "hidden", marginBottom: 8 } },
          e("div", { style: { height: "100%", width: `${Math.min(100, Math.max(0, (blockElapsed / blockLen) * 100))}%`, background: activeCat.color, transition: "width 1s linear" } })),
        e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          e("div", { style: { fontSize: 12, color: "#8C8C8C" } }, `${activeBlock.start}–${activeBlock.end} · faltam `, e("b", { style: { color: activeCat.color } }, fmtDur(Math.max(minutesLeft, 0)))),
          e("button", { onClick: () => cycleStatus(activeBlock.id), className: "rt-btn", style: { ...tinyBtn, padding: "6px 12px", fontSize: 11, background: activeCat.color, color: "#0A0A0A", fontWeight: 700 } },
            activeBlock.status === "pending" ? "marcar feito" : activeBlock.status === "done" ? "✓ feito" : "✕ falhou")
        ),
        nextBlock && e("div", { style: { marginTop: 10, paddingTop: 10, borderTop: "1px solid #2a2a2a", fontSize: 11, color: "#5a5a5a" } },
          "a seguir: ", e("span", { style: { color: "#8C8C8C" } }, `${nextBlock.start} — ${nextBlock.activity}`))
      ) : isToday && nextBlock ? e("div", { style: { background: "#141414", border: "1px solid #2a2a2a", borderLeft: "5px solid #5a5a5a", borderRadius: 10, padding: 16 } },
        e("div", { style: { fontSize: 10, letterSpacing: 1.5, color: "#5a5a5a", fontFamily: "'JetBrains Mono', monospace", marginBottom: 6 } }, "TEMPO LIVRE"),
        e("div", { style: { fontSize: 15, color: "#8C8C8C" } }, "Nenhum bloco agora. Próximo em ", e("b", { style: { color: "#F5C400" } }, fmtDur(untilNext)), `: ${nextBlock.activity} (${nextBlock.start})`)
      ) : e("div", { style: { background: "#141414", border: "1px solid #2a2a2a", borderRadius: 10, padding: 16, fontSize: 13, color: "#5a5a5a" } },
        isToday ? "Sem mais blocos hoje." : "A ver outro dia — o cartão 'agora' só aparece em hoje.")
    ),

    e("div", { style: { padding: "16px 20px 0" } },
      e("div", { style: { display: "flex", gap: 16, alignItems: "center" } },
        e("div", { style: { position: "relative", width: 56, height: 56, flexShrink: 0 } },
          e("svg", { width: 56, height: 56, viewBox: "0 0 64 64" },
            e("circle", { cx: 32, cy: 32, r: 27, fill: "none", stroke: "#1f1f1f", strokeWidth: 7 }),
            e("circle", { cx: 32, cy: 32, r: 27, fill: "none", stroke: "#F5C400", strokeWidth: 7, strokeDasharray: `${2 * Math.PI * 27}`, strokeDashoffset: `${2 * Math.PI * 27 * (1 - scoreDisplay / 100)}`, strokeLinecap: "round", transform: "rotate(-90 32 32)", style: { transition: "stroke-dashoffset .4s ease" } })
          ),
          e("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 13, color: "#F5C400" } }, `${scoreDisplay}%`)
        ),
        e("div", { style: { flex: 1, minWidth: 140 } },
          e("div", { style: { fontSize: 11, color: "#8C8C8C", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 } }, "Execução do dia"),
          e("div", { style: { fontSize: 13 } }, e("b", { style: { color: "#F5C400" } }, fmtDur(doneTotal)), " cumprido de ", e("b", null, fmtDur(plannedTotal)), " planeado",
            skippedTotal > 0 && e("span", { style: { color: "#FF6B4A" } }, ` · ${fmtDur(skippedTotal)} falhado`)),
          score !== null && e("div", { style: { fontSize: 11, color: "#8C8C8C", marginTop: 2 } }, "Taxa de acerto: ", e("b", { style: { color: score >= 70 ? "#F5C400" : "#FF6B4A" } }, `${score}%`))
        ),
        e("button", { className: "rt-btn", onClick: saveAsTemplate, style: { ...navBtn, width: "auto", padding: "0 12px", fontSize: 10.5, letterSpacing: 0.3 } }, savedTemplate ? "✓ guardado" : "usar como modelo")
      )
    ),

    error && e("div", { style: { margin: "10px 20px 0", padding: "8px 12px", background: "#2a1200", border: "1px solid #FF6B4A", color: "#FF6B4A", fontSize: 12, borderRadius: 4 } }, error),

    e("div", { ref: scrollRef, className: "rt-scroll", style: { maxHeight: 420, overflowY: "auto", padding: "16px 20px 8px", position: "relative", marginTop: 6 } },
      e("div", { style: { position: "relative", height: totalHeight, marginLeft: 52 } },
        hourMarks.map((m) => e("div", { key: m, style: { position: "absolute", top: (m - dayStart) * PX_PER_MIN, left: 0, right: 0 } },
          e("div", { style: { position: "absolute", left: -52, top: -6, fontSize: 10, color: "#5a5a5a", fontFamily: "'JetBrains Mono', monospace" } }, fromMin(m)),
          e("div", { style: { borderTop: "1px solid #1a1a1a" } })
        )),
        isToday && nowMin >= dayStart && nowMin <= dayEnd && e("div", { style: { position: "absolute", top: nowTop, left: 0, right: 0, zIndex: 5, display: "flex", alignItems: "center", gap: 6 } },
          e("span", { style: { width: 7, height: 7, borderRadius: "50%", background: "#F5C400", animation: "pulse-dot 1.4s infinite", marginLeft: -3.5 } }),
          e("div", { style: { flex: 1, height: 1.5, background: "#F5C400" } })
        ),
        sorted.map((b) => {
          const top = (toMin(b.start) - dayStart) * PX_PER_MIN;
          const height = Math.max((toMin(b.end) - toMin(b.start)) * PX_PER_MIN, 28);
          const cat = CATEGORIES[b.category] || CATEGORIES.Trabalho;
          const done = b.status === "done", skipped = b.status === "skipped";
          const isActive = activeBlock && activeBlock.id === b.id;
          return e("div", { key: b.id, style: {
            position: "absolute", top, height, left: 0, right: 0,
            background: skipped ? "#1a1010" : done ? cat.dim : "#141414",
            border: `1px solid ${isActive ? cat.color : skipped ? "#4a1c0f" : done ? cat.color : "#2a2a2a"}`,
            boxShadow: isActive ? `0 0 0 1px ${cat.color}` : "none",
            borderLeft: `4px solid ${skipped ? "#FF6B4A" : cat.color}`,
            borderRadius: 6, padding: "6px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            opacity: skipped ? 0.7 : 1,
          } },
            e("div", { style: { minWidth: 0, flex: 1 } },
              e("div", { style: { fontSize: 13, fontWeight: 600, color: skipped ? "#FF6B4A" : "#F4F0E6", whiteSpace: height < 42 ? "nowrap" : "normal", overflow: "hidden", textOverflow: "ellipsis" } },
                (done ? "✓ " : "") + (skipped ? "✕ " : "") + b.activity),
              e("div", { style: { fontSize: 10.5, color: "#8C8C8C", fontFamily: "'JetBrains Mono', monospace", marginTop: 2 } }, `${b.start}–${b.end} · ${CAT_LABEL[b.category]}`)
            ),
            e("div", { style: { display: "flex", gap: 6, flexShrink: 0 } },
              e("button", { onClick: () => cycleStatus(b.id), className: "rt-btn", style: { ...tinyBtn, background: cat.color, color: "#0A0A0A", fontWeight: 700 } },
                b.status === "pending" ? "marcar" : b.status === "done" ? "feito" : "falhou"),
              e("button", { onClick: () => removeBlock(b.id), className: "rt-btn", style: { ...tinyBtn, background: "transparent", color: "#5a5a5a", border: "1px solid #2a2a2a" } }, "×")
            )
          );
        })
      )
    ),

    e("div", { style: { padding: "14px 20px 22px", borderTop: "1px solid #1f1f1f" } },
      !showForm ? e("button", { className: "rt-btn", onClick: () => setShowForm(true), style: { width: "100%", padding: "12px", background: "#F5C400", color: "#0A0A0A", border: "none", borderRadius: 6, fontWeight: 700, fontSize: 13, letterSpacing: 0.5, cursor: "pointer" } }, "+ ADICIONAR BLOCO")
        : e("form", { onSubmit: addBlock, style: { display: "flex", flexWrap: "wrap", gap: 8, background: "#141414", padding: 12, borderRadius: 8, border: "1px solid #2a2a2a" } },
          e("input", { type: "time", value: form.start, onChange: (ev) => setForm({ ...form, start: ev.target.value }), required: true, style: inputStyle }),
          e("input", { type: "time", value: form.end, onChange: (ev) => setForm({ ...form, end: ev.target.value }), required: true, style: inputStyle }),
          e("input", { type: "text", placeholder: "Actividade", value: form.activity, onChange: (ev) => setForm({ ...form, activity: ev.target.value }), required: true, style: { ...inputStyle, flex: 1, minWidth: 160 } }),
          e("select", { value: form.category, onChange: (ev) => setForm({ ...form, category: ev.target.value }), style: inputStyle },
            CAT_KEYS.map((c) => e("option", { key: c, value: c }, CAT_LABEL[c]))),
          e("button", { type: "submit", className: "rt-btn", style: { padding: "8px 16px", background: "#F5C400", color: "#0A0A0A", border: "none", borderRadius: 5, fontWeight: 700, cursor: "pointer" } }, "Guardar"),
          e("button", { type: "button", className: "rt-btn", onClick: () => { setShowForm(false); setError(""); }, style: { padding: "8px 16px", background: "transparent", color: "#8C8C8C", border: "1px solid #2a2a2a", borderRadius: 5, cursor: "pointer" } }, "Cancelar")
        )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}
