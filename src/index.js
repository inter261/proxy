// Bot Telegram: daftar proxy V2Ray per negara (sumber: roosterkid/openproxylist)
// Secrets: BOT_TOKEN, WEBHOOK_SECRET   |   KV binding: PROXY_KV

const SRC = "https://raw.githubusercontent.com/roosterkid/openproxylist/main/V2RAY.txt";
const PAGE = 4;          // server per halaman
const KEEP = 100;        // simpan maks 100 server tercepat per negara
const TYPES = ["all", "vless", "vmess", "trojan", "ss"];
const MS_OPTS = [0, 150, 300];

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

// ---------- Tampilan ----------
async function view(env, cc, type, maxms, page) {
  const raw = await env.PROXY_KV.get("c:" + cc, "json");
  if (!raw) return { text: `Belum ada data untuk <b>${cc}</b>. Coba /negara untuk lihat negara yang tersedia.` };

  const list = raw.filter((x) => (type === "all" || x.t === type) && (!maxms || x.ms <= maxms));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);

  let items = list.slice(page * PAGE, page * PAGE + PAGE);
  const head =
    `${flag(cc)} <b>${cc}</b> · ${list.length} server · ${type}` +
    `${maxms ? ` · ≤${maxms}ms` : ""} · hal ${page + 1}/${pages}\n\n`;
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

  const cb = (t, m, p) => `l|${cc}|${t}|${m}|${p}`;
  const kb = [
    TYPES.map((t) => ({ text: (t === type ? "✅ " : "") + t, callback_data: cb(t, maxms, 0) })),
    MS_OPTS.map((m) => ({ text: (m === maxms ? "✅ " : "") + (m ? `≤${m}ms` : "semua ms"), callback_data: cb(type, m, 0) })),
  ];
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: cb(type, maxms, page - 1) });
  if (page < pages - 1) nav.push({ text: "➡️", callback_data: cb(type, maxms, page + 1) });
  if (nav.length) kb.push(nav);
  return { text, kb };
}

const HELP =
  "Bot daftar proxy V2Ray.\n\n" +
  "/proxy sg — server Singapura (kode negara 2 huruf)\n" +
  "/negara — negara yang tersedia\n\n" +
  "Tap config untuk menyalin. Proxy publik tidak aman untuk data sensitif.";

// ---------- Handler pesan ----------
async function onMessage(msg, env, ctx) {
  const chat = msg.chat.id;
  const [cmd, ...args] = (msg.text || "").trim().split(/\s+/);
  const c = cmd.split("@")[0].toLowerCase();

  if (c === "/start" || c === "/help") return tg(env, "sendMessage", { chat_id: chat, text: HELP });

  if (c === "/negara") {
    const meta = await env.PROXY_KV.get("meta", "json");
    if (!meta) {
      ctx.waitUntil(refresh(env).catch((e) => console.error(JSON.stringify({ err: String(e) }))));
      return tg(env, "sendMessage", { chat_id: chat, text: "Data belum dimuat, sedang diambil. Coba lagi sebentar." });
    }
    const rows = Object.entries(meta.n).sort((a, b) => b[1] - a[1]).map(([cc, n]) => `${flag(cc)} ${cc} (${n})`);
    const mins = Math.round((Date.now() - meta.at) / 60000);
    return tg(env, "sendMessage", { chat_id: chat, text: `${rows.join("  ")}\n\nData diperbarui ${mins} menit lalu.` });
  }

  if (c === "/proxy") {
    const cc = (args[0] || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return tg(env, "sendMessage", { chat_id: chat, text: "Contoh: /proxy sg" });
    const v = await view(env, cc, "all", 0, 0);
    return tg(env, "sendMessage", {
      chat_id: chat, text: v.text, parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(v.kb && { reply_markup: { inline_keyboard: v.kb } }),
    });
  }
}

async function onCallback(q, env) {
  const [k, cc, type, ms, page] = (q.data || "").split("|");
  if (k !== "l" || !/^[A-Z]{2}$/.test(cc) || !TYPES.includes(type)) return tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const v = await view(env, cc, type, Number(ms) || 0, Number(page) || 0);
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const r = await tg(env, "editMessageText", {
    chat_id: q.message.chat.id, message_id: q.message.message_id,
    text: v.text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(v.kb && { reply_markup: { inline_keyboard: v.kb } }),
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

    return new Response("proxy-bot");
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};
