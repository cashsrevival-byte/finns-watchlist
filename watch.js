#!/usr/bin/env node
// Headless port of the "Finn's Watchlist" browser extension's checking
// logic (see offscreen.js in the extension), meant to run on a schedule
// somewhere that isn't your own PC — a GitHub Actions cron job, in this
// setup. It does the "fetch -> parse listings -> diff against what's
// already been seen -> post new ones to Discord" half of what the
// extension does. There's no popup, no sound, no per-watch UI here — just
// the checking loop and the Discord post.
//
// State (which listing IDs have already been seen, per watched URL) is
// kept in seen.json, committed back into the repo by the workflow after
// every run, since a GitHub Actions runner is thrown away the moment the
// job ends and has no memory of the previous run otherwise.

const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "seen.json");
const FETCH_TIMEOUT_MS = 20000;
const MAX_TRACKED_IDS = 1000;

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_EMBED_COLOR = 0xff2b2b; // matches the extension popup's red theme

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ---- Site-specific extractors ----
// Ported as directly as possible from the extension's offscreen.js, just
// swapping browser DOMParser for node-html-parser (which exposes the same
// getAttribute/parentNode/text shape, so the walking-up-the-tree logic for
// finding a price near a link is unchanged).

function extractGameflipItems(html) {
  const root = parse(html);
  const anchors = root
    .querySelectorAll("a")
    .filter((a) => (a.getAttribute("href") || "").includes("/item/"));
  const uuidRe = /\/item\/([^/"?#]+)\/([0-9a-fA-F-]{20,36})/;

  const byId = new Map();
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    const m = href.match(uuidRe);
    if (!m) continue;
    const [, slug, id] = m;
    const text = (a.text || "").trim();
    const fullUrl = href.startsWith("http")
      ? href
      : new URL(href, "https://gameflip.com").toString();

    if (!byId.has(id)) {
      byId.set(id, { id, title: text || slug.replace(/-/g, " "), url: fullUrl, price: null });
    } else if (text && text.length > byId.get(id).title.length) {
      byId.get(id).title = text;
    }
  }

  const priceRe = /\$[\d,]+(?:\.\d{2})?/;
  for (const [id, item] of byId) {
    let price = null;
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (!href.includes(id)) continue;
      let el = a;
      for (let i = 0; i < 6 && el && !price; i++) {
        el = el.parentNode;
        if (!el) break;
        const m2 = (el.text || "").match(priceRe);
        if (m2) price = m2[0];
      }
      if (price) break;
    }
    item.price = price;
  }

  return Array.from(byId.values());
}

// See offscreen.js in the extension for why the id is username+price
// folded together rather than a stable per-offer id.
function extractEldoradoItems(html) {
  const root = parse(html);
  const anchors = root
    .querySelectorAll("a")
    .filter((a) => (a.getAttribute("href") || "").includes("/users/"));
  const userRe = /\/users\/([^/"?#]+)\/shop/;
  const priceRe = /\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*unit/i;
  const minQtyRe = /Min\.?\s*qty\.?:?\s*([\d,]+)/i;

  const byUser = new Map();
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    const m = href.match(userRe);
    if (!m) continue;
    const username = decodeURIComponent(m[1]);
    if (byUser.has(username)) continue;

    let priceText = null;
    let minQtyText = null;
    let el = a;
    for (let i = 0; i < 8 && el; i++) {
      el = el.parentNode;
      if (!el) break;
      const text = el.text || "";
      if (!priceText) {
        const pm = text.match(priceRe);
        if (pm) priceText = pm[1];
      }
      if (!minQtyText) {
        const qm = text.match(minQtyRe);
        if (qm) minQtyText = qm[1];
      }
      if (priceText && minQtyText) break;
    }

    const fullUrl = href.startsWith("http")
      ? href
      : new URL(href, "https://www.eldorado.gg").toString();
    const price = priceText ? `$${priceText} / unit` : null;
    const id = username + "|" + (priceText || "");
    const titleParts = [username];
    if (price) titleParts.push(price);
    if (minQtyText) titleParts.push(`min ${minQtyText}`);

    byUser.set(username, { id, title: titleParts.join(" — "), url: fullUrl, price });
  }

  return Array.from(byUser.values());
}

function extractItems(html, searchUrl) {
  let hostname = "";
  try {
    hostname = new URL(searchUrl).hostname;
  } catch (e) {
    // hostname stays empty, handled below
  }

  if (hostname.endsWith("gameflip.com")) return extractGameflipItems(html);
  if (hostname.endsWith("eldorado.gg")) return extractEldoradoItems(html);

  throw new Error(`No listing parser for "${hostname || searchUrl}" — only gameflip.com and eldorado.gg are supported.`);
}

// ---- Discord ----

function discordEmbedFor(item) {
  const embed = {
    title: (item.title || "New listing").slice(0, 250),
    url: item.url,
    color: DISCORD_EMBED_COLOR
  };
  if (item.price) embed.description = item.price;
  return embed;
}

async function postNewItemsToDiscord(items, searchUrl) {
  if (!items.length || !DISCORD_WEBHOOK_URL) return;

  let hostname = "listing";
  try {
    hostname = new URL(searchUrl).hostname;
  } catch (e) {
    // keep the fallback
  }

  // Discord rejects a message with more than 10 embeds, so batch.
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const payload = { username: "Finn's Watchlist", embeds: batch.map(discordEmbedFor) };
    if (i === 0) {
      payload.content = `🏀 **${items.length} new listing${items.length > 1 ? "s" : ""}** on ${hostname}`;
    }
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error("Discord post failed:", res.status, await res.text().catch(() => ""));
    }
  }
}

// ---- Main ----

async function checkWatch(watch, state) {
  const label = watch.name || watch.url;
  const key = watch.url;
  const entry = state[key] || {};
  const seenIds = new Set(entry.seenIds || []);
  const initialized = !!entry.initialized;

  let html;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(watch.url, {
        signal: controller.signal,
        // A default Node fetch UA gets blocked/served differently by some
        // sites more often than a normal-looking browser UA does.
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error(`[${label}] fetch failed:`, String(e));
    return;
  }

  let items;
  try {
    items = extractItems(html, watch.url);
  } catch (e) {
    console.error(`[${label}] parse failed:`, String(e));
    return;
  }

  const newItems = initialized ? items.filter((i) => !seenIds.has(i.id)) : [];
  const combined = [...items.map((i) => i.id), ...seenIds];
  const dedupedIds = Array.from(new Set(combined)).slice(0, MAX_TRACKED_IDS);

  state[key] = { seenIds: dedupedIds, initialized: true, lastChecked: Date.now() };

  console.log(`[${label}] tracked=${items.length} new=${newItems.length}`);

  if (newItems.length > 0) {
    await postNewItemsToDiscord(newItems, watch.url);
  }
}

async function main() {
  if (!DISCORD_WEBHOOK_URL) {
    console.error(
      "DISCORD_WEBHOOK_URL is not set (add it as a repo secret) — watches will still be checked and tracked, but nothing will be posted to Discord."
    );
  }

  const config = loadJson(CONFIG_PATH, { watches: [] });
  const state = loadJson(STATE_PATH, {});

  for (const watch of config.watches) {
    await checkWatch(watch, state);
  }

  saveJson(STATE_PATH, state);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
