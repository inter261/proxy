// Bot Telegram: daftar proxy V2Ray per negara (sumber: roosterkid/openproxylist)
// Secrets: BOT_TOKEN, WEBHOOK_SECRET   |   KV binding: PROXY_KV

const SRC = "https://raw.githubusercontent.com/roosterkid/openproxylist/main/V2RAY.txt";
const PAGE = 4;          // server per halaman
const KEEP = 100;        // simpan maks 100 server tercepat per negara
const TYPE_BITS = { vmess: 1, vless: 2, trojan: 4, ss: 8 };
const TYPE_LABEL = { vmess: "VMess", vless: "VLESS", trojan: "Trojan VPN", ss: "Shadowsocks" };
const MS_OPTS = [0, 100, 200, 300, 500];   // 0 = semua
const COUNTRY_PAGE = 12;                    // negara per halaman di pemilih negara
const DEFAULT = { cc: "--", t: 3, ms: 0 };  // belum pilih negara, VMess+VLESS dicentang (seperti di website)

// Format baris: CONFIG[ label] 157ms NL [ISP]
const LINE = /^(?:\S+\s+)?((?:vless|vmess|trojan|ss):\/\/\S+)(?:\s+[a-z0-9]+-[A-Z]{2})?\s+(\d+)\s*ms\s+([A-Z]{2})(?:\s+\[([^\]]*)\]?)?/;

export function parseLine(line) {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const [, c, ms, cc, isp] = m;
  return { c, t: c.slice(0, c.indexOf(":")), ms: Number(ms), cc, i: (isp || "").slice(0, 40) };
}

// ---------- Ambil & simpan data ----------
async function refresh(env) {
  const res = await fetch(SRC);
  if (!res.ok || !res.body) throw new Error("fetch sumber gagal: " + res.status);

  const by = {};
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const take = (line) => {
    const p = parseLine(line);
    if (p) (by[p.cc] ||= []).push(p);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) take(l);
  }
  take(buf);

  const counts = {};
  const writes = [];
  for (const [cc, arr] of Object.entries(by)) {
    arr.sort((a, b) => a.ms - b.ms);
    counts[cc] = arr.length;
    writes.push(env.PROXY_KV.put("c:" + cc, JSON.stringify(arr.slice(0, KEEP).map(({ cc: _, ...r }) => r))));
  }
  writes.push(env.PROXY_KV.put("meta", JSON.stringify({ at: Date.now(), n: counts })));
  await Promise.all(writes);
  return Object.keys(counts).length;
}

// ---------- Helper Telegram ----------
const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

// ---------- State filter (disimpan di callback_data, tanpa KV) ----------
// callback_data = aksi|negara|maskTipe|ms|extra
const cbd = (act, s, extra) => [act, s.cc, s.t, s.ms, ...(extra === undefined ? [] : [extra])].join("|");

function parseCb(data) {
  const [act, cc, t, ms, x] = String(data || "").split("|");
  return {
    act,
    x: Number(x) || 0,
    s: {
      cc: /^([A-Z]{2}|--)$/.test(cc) ? cc : "--",
      t: (Number(t) & 15) || DEFAULT.t,
      ms: MS_OPTS.includes(Number(ms)) ? Number(ms) : 0,
    },
  };
}

const typeNames = (mask) =>
  Object.keys(TYPE_BITS).filter((k) => mask & TYPE_BITS[k]).map((k) => TYPE_LABEL[k]).join(", ") || "-";

// ---------- Tampilan ----------
function menuView(s) {
  const text =
    "<b>Filter proxy</b>\n\n" +
    `Negara: ${s.cc === "--" ? "belum dipilih" : `${flag(s.cc)} ${s.cc}`}\n` +
    `Response time: ${s.ms ? `≤${s.ms} ms` : "semua"}\n` +
    `Tipe: ${typeNames(s.t)}\n\n` +
    "Atur filter, lalu tap 🔍 Cari.";
  const typeBtn = (k) => ({
    text: `${s.t & TYPE_BITS[k] ? "✅" : "☐"} ${TYPE_LABEL[k]}`,
    callback_data: cbd("t", s, TYPE_BITS[k]),
  });
  const kb = [
    [{ text: `🌍 Negara: ${s.cc === "--" ? "pilih…" : s.cc}`, callback_data: cbd("c", s, 0) }],
    MS_OPTS.map((m) => ({
      text: `${m === s.ms ? "✅ " : ""}${m ? `≤${m}` : "Semua ms"}`,
      callback_data: cbd("m", { ...s, ms: m }),
    })),
    [typeBtn("vmess"), typeBtn("vless")],
    [typeBtn("trojan"), typeBtn("ss")],
    [{ text: "🔍 Cari", callback_data: cbd("g", s, 0) }],
  ];
  return { text, kb };
}

async function countryView(env, s, page) {
  const meta = await env.PROXY_KV.get("meta", "json");
  if (!meta) return null;
  const all = Object.entries(meta.n).sort((a, b) => b[1] - a[1]);
  const pages = Math.max(1, Math.ceil(all.length / COUNTRY_PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const slice = all.slice(page * COUNTRY_PAGE, page * COUNTRY_PAGE + COUNTRY_PAGE);

  const kb = [];
  for (let i = 0; i < slice.length; i += 3)
    kb.push(slice.slice(i, i + 3).map(([cc, n]) => ({ text: `${flag(cc)} ${cc} (${n})`, callback_data: cbd("m", { ...s, cc }) })));
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: cbd("c", s, page - 1) });
  nav.push({ text: "↩️ Kembali", callback_data: cbd("m", s) });
  if (page < pages - 1) nav.push({ text: "➡️", callback_data: cbd("c", s, page + 1) });
  kb.push(nav);
  return { text: `<b>Pilih negara</b> · hal ${page + 1}/${pages}`, kb };
}

async function resultView(env, s, page) {
  const back = [{ text: "🔧 Ubah filter", callback_data: cbd("m", s) }];
  const raw = await env.PROXY_KV.get("c:" + s.cc, "json");
  if (!raw) return { text: `Belum ada data untuk <b>${s.cc}</b>.`, kb: [back] };

  const list = raw.filter((x) => s.t & (TYPE_BITS[x.t] || 0) && (!s.ms || x.ms <= s.ms));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);

  let items = list.slice(page * PAGE, page * PAGE + PAGE);
  const head =
    `${flag(s.cc)} <b>${s.cc}</b> · ${list.length} server · ${typeNames(s.t)}` +
    `${s.ms ? ` · ≤${s.ms}ms` : ""} · hal ${page + 1}/${pages}\n\n`;
  const foot = "\n\n<i>Ping berasal dari checker OpenProxyList, bukan tes dari bot ini.</i>";
  const render = (arr) =>
    head +
    (arr.length
      ? arr
          .map((x, i) => `<b>${page * PAGE + i + 1}.</b> ${x.t.toUpperCase()} · ${x.ms}ms · ${esc(x.i)}\n<code>${esc(x.c)}</code>`)
          .join("\n\n")
      : "Tidak ada server yang cocok dengan filter ini.") +
    foot;
  let text = render(items);
  while (text.length > 4000 && items.length > 1) text = render((items = items.slice(0, -1)));

  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: cbd("g", s, page - 1) });
  if (page < pages - 1) nav.push({ text: "➡️", callback_data: cbd("g", s, page + 1) });
  return { text, kb: nav.length ? [nav, back] : [back] };
}

const HELP =
  "Bot daftar proxy V2Ray.\n\n" +
  "Tap tombol /start di bawah untuk mulai mencari. Tap config untuk menyalin.\n" +
  "Proxy publik tidak aman untuk data sensitif.";

const html = (v) => ({
  text: v.text, parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
  reply_markup: { inline_keyboard: v.kb },
});

// ---------- Handler ----------
async function onMessage(msg, env, ctx) {
  const chat = msg.chat.id;
  const c = (msg.text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (c !== "/start" && c !== "/help") return;

  if (!(await env.PROXY_KV.get("meta")))
    ctx.waitUntil(refresh(env).catch((e) => console.error(JSON.stringify({ err: String(e) }))));

  // tombol /start permanen di bawah layar
  await tg(env, "sendMessage", {
    chat_id: chat, text: HELP,
    reply_markup: { keyboard: [[{ text: "/start" }]], resize_keyboard: true, is_persistent: true },
  });
  return tg(env, "sendMessage", { chat_id: chat, ...html(menuView(DEFAULT)) });
}

async function onCallback(q, env) {
  const { act, x, s } = parseCb(q.data);
  const answer = (extra) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...extra });

  let v;
  if (act === "m") v = menuView(s);
  else if (act === "t") v = menuView({ ...s, t: (s.t ^ x) || s.t }); // minimal satu tipe tetap aktif
  else if (act === "c") {
    v = await countryView(env, s, x);
    if (!v) return answer({ text: "Data belum dimuat, coba lagi sebentar.", show_alert: true });
  } else if (act === "g") {
    if (s.cc === "--") return answer({ text: "Pilih negara dulu.", show_alert: true });
    v = await resultView(env, s, x);
  } else return answer();

  await answer();
  const r = await tg(env, "editMessageText", {
    chat_id: q.message.chat.id, message_id: q.message.message_id, ...html(v),
  });
  if (!r.ok && !String(r.description).includes("not modified")) console.error(JSON.stringify(r));
}

// ---------- Keamanan ----------
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a || "")),
    crypto.subtle.digest("SHA-256", enc.encode(b || "")),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/webhook") {
      if (!(await safeEqual(req.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)))
        return new Response("forbidden", { status: 403 });
      const u = await req.json();
      const job = u.message?.text ? onMessage(u.message, env, ctx) : u.callback_query ? onCallback(u.callback_query, env) : null;
      if (job) ctx.waitUntil(job.catch((e) => console.error(JSON.stringify({ err: String(e) }))));
      return new Response("ok");
    }

    // Buka sekali: /setup?key=<WEBHOOK_SECRET> -> pasang webhook + muat data pertama
    if (url.pathname === "/setup") {
      if (!(await safeEqual(url.searchParams.get("key"), env.WEBHOOK_SECRET))) return new Response("forbidden", { status: 403 });
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"],
      });
      let negara = "gagal";
      try { negara = String(await refresh(env)); } catch (e) { negara = "gagal: " + e; }
      return Response.json({ webhook: hook, negara_dimuat: negara });
    }

    return new Response("proxy");
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};
