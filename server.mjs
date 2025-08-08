import "dotenv/config";
import express from "express";
import { chromium } from "playwright";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const GLOBAL = {
  POLL_SECONDS: +(process.env.POLL_SECONDS || 60),
  HEADLESS: (process.env.HEADLESS || "true").toLowerCase() === "true",
  DISCORD_WEBHOOK: (process.env.DISCORD_WEBHOOK || "").trim(),
  ALERT_COOLDOWN_SEC: +(process.env.ALERT_COOLDOWN_SEC || 90),
};
console.log("[boot]", {
  poll: GLOBAL.POLL_SECONDS,
  headless: GLOBAL.HEADLESS,
  webhook: GLOBAL.DISCORD_WEBHOOK ? "SET" : "NOT SET",
  cooldown: GLOBAL.ALERT_COOLDOWN_SEC,
});

// ===== Store =====
// item: { id, name, url, enabled, lastCheck, alerts, buyHash, lastBuyCount, lastAlertAt }
const items = new Map();
const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function addItem({ name, url, enabled = true }) {
  const id = newId();
  const it = {
    id,
    name,
    url,
    enabled,
    lastCheck: null,
    alerts: 0,
    buyHash: null,
    lastBuyCount: 0,
    lastAlertAt: 0,
  };
  items.set(id, it);
  return it;
}

// ===== Utils =====
const nowSec = () => Math.floor(Date.now() / 1000);
const hashString = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
};
const normalizeNum = (x) => {
  const f = parseFloat(String(x).replace(",", "."));
  return Number.isFinite(f) ? +f.toFixed(10) : null;
};
const looksLikeMarketUrl = (u) =>
  /(orderbook|order-book|book|orders|bids?|buy)/i.test(u);

// ===== Estrazione BUY da JSON =====
function extractBuysFromJson(data) {
  const buys = [];
  const scan = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(scan);
      return;
    }
    if (typeof node === "object") {
      const keys = Object.keys(node).map((k) => k.toLowerCase());
      const get = (names) => {
        for (const k of keys)
          for (const n of names)
            if (k === n || k.endsWith("_" + n) || k.includes(n))
              return node[Object.keys(node)[keys.indexOf(k)]];
        return undefined;
      };
      const price = normalizeNum(get(["price", "p", "bid", "bestbid"]));
      const qty = normalizeNum(get(["quantity", "qty", "q", "amount", "size"]));
      const side = String(get(["side", "type", "order_type"]) ?? "").toLowerCase();

      if (price !== null && qty !== null && (!side || /buy|bid/.test(side))) {
        buys.push({ price, qty });
      }
      for (const v of Object.values(node)) scan(v);
    }
  };
  scan(data);

  // top of book stabile (prime 15 bid)
  buys.sort((a, b) => b.price - a.price);
  const top = buys.slice(0, 15);
  const signature = top
    .map((o) => `${o.price.toFixed(8)}|${o.qty.toFixed(8)}`)
    .join("\n");
  return { list: top, signature: signature ? hashString(signature) : "" };
}

// ===== Snapshot: ascolta XHR/JSON dell’order book =====
async function snapshotNetwork(url, headless = true) {
  const browser = await chromium.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage();
  const jsonTexts = [];

  page.on("response", async (resp) => {
    try {
      const ctype = resp.headers()["content-type"] || "";
      const u = resp.url();
      if (!ctype?.includes("application/json")) return;
      if (!looksLikeMarketUrl(u)) return;
      const t = await resp.text();
      jsonTexts.push(t);
    } catch {}
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  await browser.close();

  let signatures = [];
  let totalBuyCount = 0;

  for (const t of jsonTexts) {
    try {
      const data = JSON.parse(t);
      const { list, signature } = extractBuysFromJson(data);
      if (signature) {
        signatures.push(signature);
        totalBuyCount += list.length;
      }
    } catch {}
  }

  return { buySignatures: signatures, buyCount: totalBuyCount };
}

// ===== Discord (embed colorato per nome) =====
function colorFromName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (h >>> 0) & 0xffffff; // 0xRRGGBB
}

async function sendDiscordEmbed({ username, title, description, url, color }) {
  if (!GLOBAL.DISCORD_WEBHOOK) return;
  try {
    const r = await fetch(GLOBAL.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username, // mittente = nome oggetto
        embeds: [{ title, description, url, color }],
      }),
    });
    if (!(r.status === 204 || r.ok)) {
      const txt = await r.text().catch(() => "(no body)");
      console.log("[discord] embed fail", r.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.log("[discord] embed error", e);
  }
}

// ===== Check =====
async function checkItem(item) {
  if (!item.enabled) return;
  const { buySignatures, buyCount } = await snapshotNetwork(
    item.url,
    GLOBAL.HEADLESS
  );
  item.lastCheck = new Date().toISOString();
  if (buySignatures.length === 0) return;

  const combinedHash = hashString(buySignatures.join("|"));
  if (item.buyHash && item.buyHash !== combinedHash) {
    // cooldown anti-spam
    if (nowSec() - item.lastAlertAt >= GLOBAL.ALERT_COOLDOWN_SEC) {
      item.alerts++;
      item.lastAlertAt = nowSec();
      const diff = buyCount - item.lastBuyCount;

      await sendDiscordEmbed({
        username: item.name,
        title: `BUY ORDERS aggiornati — ${item.name}`,
        description:
          `Variazione righe BUY (stima): ${item.lastBuyCount} → ${buyCount} ` +
          `(${diff >= 0 ? "+" + diff : diff})\n` +
          `${item.url}`,
        url: item.url,
        color: colorFromName(item.name),
      });
    }
  }

  item.buyHash = combinedHash;
  item.lastBuyCount = buyCount;
}

// ===== Scheduler =====
(async function loop() {
  while (true) {
    const active = Array.from(items.values()).filter((i) => i.enabled);
    for (const it of active) {
      try {
        await checkItem(it);
      } catch (e) {
        console.log("check error:", it.name, e);
      }
      await new Promise((r) => setTimeout(r, 800)); // micro-pausa tra item
    }
    await new Promise((r) =>
      setTimeout(r, Math.max(5, GLOBAL.POLL_SECONDS) * 1000)
    );
  }
})();

// ===== API per UI =====
app.get("/api/items", (_, res) =>
  res.json({ items: Array.from(items.values()), pollSeconds: GLOBAL.POLL_SECONDS })
);

app.post("/api/items", (req, res) => {
  const { name, url, enabled = true } = req.body || {};
  if (!name || !url)
    return res
      .status(400)
      .json({ ok: false, error: "name e url obbligatori" });
  const it = addItem({ name, url, enabled });
  res.json({ ok: true, item: it });
});

app.patch("/api/items/:id", (req, res) => {
  const it = items.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: "not found" });
  const { name, url, enabled } = req.body || {};
  if (name !== undefined) it.name = name;
  if (url !== undefined) {
    it.url = url;
    it.buyHash = null;
    it.lastBuyCount = 0; // reset baseline se cambia URL
  }
  if (enabled !== undefined) it.enabled = !!enabled;
  res.json({ ok: true, item: it });
});

app.delete("/api/items/:id", (req, res) =>
  res.json({ ok: items.delete(req.params.id) })
);

app.post("/api/run/:id", async (req, res) => {
  const it = items.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: "not found" });
  try {
    await checkItem(it);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/test-discord", async (_, res) => {
  await sendDiscordEmbed({
    username: "Test Monitor",
    title: "✅ Test webhook: connesso",
    description: "Questo è un messaggio di prova.",
    url: "https://example.com",
    color: 0x43b581,
  });
  res.json({ ok: true });
});

// Seed (disabilitato)
addItem({
  name: "Infrastructure Contract",
  url: "https://atlas.eveeye.com/?market&markets=2&item=oicT4ECU7nuPBZD2HUg8sb9nG4MDXWaE8vAnzwzXqcg&currency=ATLAS&chart=area",
  enabled: false,
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(new Date().toISOString(), "Server on :" + PORT)
);
