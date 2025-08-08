import "dotenv/config";
import express from "express";
import { chromium } from "playwright";
import fetch from "node-fetch";

/* ---------- Config ---------- */
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

/* ---------- In-memory store ---------- */
// item: { id, name, url, enabled, lastCheck, alerts, buyHash, lastBuyCount, lastAlertAt, faction }
const items = new Map();
const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function addItem({ name, url, faction, enabled = true }) {
  const it = {
    id: newId(),
    name,
    url,
    faction,
    enabled,
    lastCheck: null,
    alerts: 0,
    buyHash: null,
    lastBuyCount: 0,
    lastAlertAt: 0,
  };
  items.set(it.id, it);
  return it;
}

/* ---------- Utils ---------- */
const nowSec = () => Math.floor(Date.now() / 1000);
const hashString = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
};
const normalizeNum = (x) => {
  const f = parseFloat(String(x).replace(",", "."));
  return Number.isFinite(f) ? +f.toFixed(10) : null;
};
const looksLikeMarketUrl = (u) =>
  /(orderbook|order-book|book|orders|bids?|buy)/i.test(u);

/* ---------- Estrazione BUY dai JSON ---------- */
function extractBuysFromJson(data) {
  const buys = [];
  const scan = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(scan);
    if (typeof node === "object") {
      const keys = Object.keys(node).map((k) => k.toLowerCase());
      const get = (names) => {
        for (const k of keys) {
          for (const n of names) {
            if (
              k === n ||
              k.endsWith("_" + n) ||
              k.includes(n)
            )
              return node[Object.keys(node)[keys.indexOf(k)]];
          }
        }
        return undefined;
      };
      const price = normalizeNum(get(["price", "p", "bid", "bestbid"]));
      const qty = normalizeNum(get(["quantity", "qty", "q", "amount", "size"]));
      const side = String(
        get(["side", "type", "order_type"]) ?? ""
      ).toLowerCase();
      if (
        price !== null &&
        qty !== null &&
        (!side || /buy|bid/.test(side))
      )
        buys.push({ price, qty });
      for (const v of Object.values(node)) scan(v);
    }
  };
  scan(data);
  buys.sort((a, b) => b.price - a.price);
  const top = buys.slice(0, 15);
  const signature = top
    .map((o) => `${o.price.toFixed(8)}|${o.qty.toFixed(8)}`)
    .join("\n");
  return { list: top, signature: signature ? hashString(signature) : "" };
}

/* ---------- Snapshot rete: intercetta XHR/JSON ---------- */
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

/* ---------- Discord embeds con icone ---------- */
function factionIconAndColor(faction) {
  switch (faction) {
    case "oni":
      return { emoji: "🔵", color: 0x3498db };
    case "mud":
      return { emoji: "🔴", color: 0xe74c3c };
    case "ustur":
      return { emoji: "🟡", color: 0xf1c40f };
    default:
      return { emoji: "⚪", color: 0x95a5a6 };
  }
}

async function sendDiscordEmbed({ item, diff, buyCount }) {
  if (!GLOBAL.DISCORD_WEBHOOK) return;
  const { emoji, color } = factionIconAndColor(item.faction);
  try {
    const r = await fetch(GLOBAL.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `${emoji} ${item.name}`,
        embeds: [
          {
            title: `BUY ORDERS aggiornati — ${item.name}`,
            description:
              `Variazione righe BUY: ${item.lastBuyCount} → ${buyCount} ` +
              `(${diff >= 0 ? "+" + diff : diff})\n${item.url}`,
            url: item.url,
            color,
          },
        ],
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

/* ---------- Check singolo item ---------- */
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
    if (nowSec() - item.lastAlertAt >= GLOBAL.ALERT_COOLDOWN_SEC) {
      item.alerts++;
      item.lastAlertAt = nowSec();
      const diff = buyCount - item.lastBuyCount;
      await sendDiscordEmbed({ item, diff, buyCount });
    }
  }
  item.buyHash = combinedHash;
  item.lastBuyCount = buyCount;
}

/* ---------- Scheduler ---------- */
function startScheduler() {
  (async function loop() {
    while (true) {
      const active = Array.from(items.values()).filter((i) => i.enabled);
      for (const it of active) {
        try {
          await checkItem(it);
        } catch (e) {
          console.log("check error:", it.name, e);
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      await new Promise((r) =>
        setTimeout(r, Math.max(5, GLOBAL.POLL_SECONDS) * 1000)
      );
    }
  })();
}

/* ---------- API + Health ---------- */
const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.status(200).send("Bot is running!"));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date() }));

/* ---------- Seed iniziale con link e fazioni ---------- */
// Oni (blu)
addItem({ name: "Oni Infrastructure Contract", url: "https://atlas.eveeye.com/?market&markets=2&item=oicT4ECU7nuPBZD2HUg8sb9nG4MDXWaE8vAnzwzXqcg&currency=ATLAS&chart=area", faction: "oni" });
addItem({ name: "Oni Contract Vaors Order", url: "https://atlas.eveeye.com/?market&markets=2&item=oiC26XFt8HR1xzw3Y6WJ9wMTdtY1g9k1mthMqwRAn1X&currency=ATLAS&chart=area", faction: "oni" });
addItem({ name: "Oni Quantum Nodes", url: "https://atlas.eveeye.com/?market&markets=2&item=ic3AfsMFGKjkftEkpZLLdCGHmSQX5RwH92zhXUZVNCW&currency=ATLAS&chart=area", faction: "oni" });
addItem({ name: "Oni Starpath Cells", url: "https://atlas.eveeye.com/?market&markets=2&item=ic3BNHDBzoW8suW4q9a9qt5PkK7D38T4raGDc1gyuRh&currency=ATLAS&chart=area", faction: "oni" });

// Mud (rosso)
addItem({ name: "Mud Quantum Nodes", url: "https://atlas.eveeye.com/?market&markets=1&item=ic3AfsMFGKjkftEkpZLLdCGHmSQX5RwH92zhXUZVNCW&currency=ATLAS&chart=area", faction: "mud" });
addItem({ name: "Mud Starpath Cells", url: "https://atlas.eveeye.com/?market&markets=1&item=ic3BNHDBzoW8suW4q9a9qt5PkK7D38T4raGDc1gyuRh&currency=ATLAS&chart=area", faction: "mud" });
addItem({ name: "Mud Gotti's Favor", url: "https://atlas.eveeye.com/?market&markets=1&item=mic2AcEbMAjxoYGWaobvTMKzzNraSRVFaDaKEM2YrTD&currency=ATLAS&chart=area", faction: "mud" });
addItem({ name: "Mud Infrastructure Contract", url: "https://atlas.eveeye.com/?market&markets=1&item=mic9ZayXBs7x3T6qgM2VskuaWFC8egCQBkTHcy8BoPM&currency=ATLAS&chart=area", faction: "mud" });

// Ustur (giallo)
addItem({ name: "Ustur Opo's Request", url: "https://atlas.eveeye.com/?market&markets=3&item=uiC2QNxpUxu1VqFefrbN6eDucaW2g9YnB4EZosMQeec&currency=ATLAS&chart=area", faction: "ustur" });
addItem({ name: "Ustur Infrastructure Contract", url: "https://atlas.eveeye.com/?market&markets=3&item=uicF2zhVoZguiFbr2KWp3kFBYwezs6HZqMzQfLbXw1A&currency=ATLAS&chart=area", faction: "ustur" });
addItem({ name: "Ustur Quantum Nodes", url: "https://atlas.eveeye.com/?market&markets=3&item=ic3AfsMFGKjkftEkpZLLdCGHmSQX5RwH92zhXUZVNCW&currency=ATLAS&chart=area", faction: "ustur" });
addItem({ name: "Ustur Starpath Cells", url: "https://atlas.eveeye.com/?market&markets=3&item=ic3BNHDBzoW8suW4q9a9qt5PkK7D38T4raGDc1gyuRh&currency=ATLAS&chart=area", faction: "ustur" });

/* ---------- Avvio server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(new Date().toISOString(), "Server on :" + PORT);
  setTimeout(startScheduler, 8000);
});
