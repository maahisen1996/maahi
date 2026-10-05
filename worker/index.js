const GITHUB_OWNER = "maahisen1996";
const GITHUB_REPO = "maahi";
const GITHUB_BRANCH = "main";
const GRAPH_BASE = "https://graph.instagram.com/v25.0";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function pacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function randInt(min, max) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return min + (a[0] % (max - min + 1));
}

async function recordEvent(env, key, payload) {
  try {
    await env.MAAHI_STATE.put(key, JSON.stringify({
      at: new Date().toISOString(),
      ...payload,
    }), { expirationTtl: 604800 });
  } catch (_) {}
}

async function gh(path) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
  const r = await fetch(url, {
    headers: {
      "user-agent": "maahi-instagram-worker",
      accept: "application/vnd.github+json",
    },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`GitHub ${path}: ${r.status} ${await r.text()}`);
  return r;
}

async function listQueue() {
  const r = await gh("queue");
  const items = await r.json();
  const captions = new Map();
  const images = new Set();
  for (const item of items) {
    if (item.type !== "file") continue;
    if (item.name === "test-trigger.txt") continue;
    if (item.name.endsWith(".txt")) captions.set(item.name.slice(0, -4), item.download_url);
    if (item.name.endsWith(".jpg.b64")) images.add(item.name.slice(0, -8));
  }
  return [...captions.entries()]
    .filter(([stem]) => images.has(stem))
    .map(([stem, captionUrl]) => ({ stem, captionUrl }))
    .sort((a, b) => a.stem.localeCompare(b.stem));
}

async function getCaption(item) {
  const r = await fetch(item.captionUrl, { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error(`Caption ${item.stem}: ${r.status}`);
  return (await r.text()).trim();
}

async function getImageBytes(stem) {
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/queue/${encodeURIComponent(stem)}.jpg.b64`;
  const r = await fetch(rawUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error(`Image ${stem}: ${r.status}`);
  const encoded = (await r.text()).replace(/\s/g, "");
  const raw = atob(encoded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function alreadyOnInstagram(env, caption) {
  const u = new URL(`${GRAPH_BASE}/${env.IG_USER_ID}/media`);
  u.searchParams.set("fields", "id,caption,timestamp");
  u.searchParams.set("limit", "25");
  const r = await fetch(u, {
    headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS}` },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Instagram media lookup ${r.status}: ${body}`);
  }
  const data = await r.json();
  const found = (data.data || []).find((x) => (x.caption || "").trim() === caption.trim());
  return found?.id || null;
}

async function igPost(url, body, env) {
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS}` },
    body: new URLSearchParams(body),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok || !data.id) throw new Error(`Instagram ${r.status}: ${text}`);
  return data;
}

async function publishStem(stem, env) {
  let phase = "start";
  try {
    phase = "list-queue";
    const queue = await listQueue();
    const item = queue.find((x) => x.stem === stem || x.stem.startsWith(`${stem}_`));
    if (!item) throw new Error(`Queue item not found: ${stem}`);
    stem = item.stem;

    phase = "check-posted";
    const done = await env.MAAHI_STATE.get(`posted:${stem}`);
    if (done) return { ok: true, skipped: "already-marked", stem, media_id: done };

    phase = "caption";
    const caption = await getCaption(item);

    phase = "instagram-duplicate-check";
    const existing = await alreadyOnInstagram(env, caption);
    if (existing) {
      await env.MAAHI_STATE.put(`posted:${stem}`, existing);
      await recordEvent(env, "last_success", { stem, phase: "already-on-instagram", media_id: existing });
      return { ok: true, skipped: "already-on-instagram", stem, media_id: existing };
    }

    const leaseKey = `lease:${stem}`;
    phase = "lease";
    const lease = await env.MAAHI_STATE.get(leaseKey);
    if (lease) return { ok: false, skipped: "lease-active", stem };
    await env.MAAHI_STATE.put(leaseKey, String(Date.now()), { expirationTtl: 900 });

    try {
      phase = "create-container";
      const imageUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/image/${encodeURIComponent(stem)}`;
      const container = await igPost(`${GRAPH_BASE}/${env.IG_USER_ID}/media`, {
        image_url: imageUrl,
        caption,
      }, env);

      phase = "wait-processing";
      for (let i = 0; i < 18; i++) {
        const u = new URL(`${GRAPH_BASE}/${container.id}`);
        u.searchParams.set("fields", "status_code,status");
        const r = await fetch(u, { headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS}` } });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        if (!r.ok) throw new Error(`Instagram processing lookup ${r.status}: ${text}`);
        if (data.status_code === "FINISHED") break;
        if (["ERROR", "EXPIRED"].includes(data.status_code)) throw new Error(`Instagram processing ${data.status_code}: ${text}`);
        if (i === 17) throw new Error(`Instagram processing timed out: ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      phase = "publish-container";
      const published = await igPost(`${GRAPH_BASE}/${env.IG_USER_ID}/media_publish`, {
        creation_id: container.id,
      }, env);
      await env.MAAHI_STATE.put(`posted:${stem}`, published.id);
      await env.MAAHI_STATE.delete(leaseKey);
      await recordEvent(env, "last_success", { stem, phase: "published", media_id: published.id });
      await env.MAAHI_STATE.delete("last_error");
      return { ok: true, stem, media_id: published.id };
    } catch (e) {
      await env.MAAHI_STATE.delete(leaseKey);
      throw e;
    }
  } catch (e) {
    await recordEvent(env, "last_error", {
      stem,
      phase,
      message: String(e?.message || e),
    });
    throw e;
  }
}

async function ensureDailyPlan(env) {
  const now = pacificParts();
  const key = `plan:${now.date}`;
  const existing = await env.MAAHI_STATE.get(key, "json");
  if (existing) return existing;

  const roll = randInt(1, 100);
  const count = roll <= 70 ? 1 : 2;
  const windows = [
    ["10:00", "14:00"],
    ["18:00", "21:30"],
  ];
  const slots = [];
  for (let i = 0; i < count; i++) {
    const [start, end] = windows[i];
    const pick = randInt(minutesOfDay(start), minutesOfDay(end));
    slots.push({ minute: pick, done: false, post_id: null });
  }
  const plan = { date: now.date, slots };
  await env.MAAHI_STATE.put(key, JSON.stringify(plan), { expirationTtl: 172800 });
  return plan;
}

async function scheduledRun(env) {
  await recordEvent(env, "last_run", { phase: "scheduled-start" });
  const now = pacificParts();
  const plan = await ensureDailyPlan(env);
  const currentMinute = minutesOfDay(now.time);
  const queue = await listQueue();
  const available = [];
  for (const item of queue) {
    if (!(await env.MAAHI_STATE.get(`posted:${item.stem}`))) available.push(item.stem);
  }

  for (let i = 0; i < plan.slots.length; i++) {
    const slot = plan.slots[i];
    if (slot.done || currentMinute < slot.minute || available.length === 0) continue;
    const stem = available[0];
    const result = await publishStem(stem, env);
    if (result.ok) {
      slot.done = true;
      slot.post_id = result.stem;
      await env.MAAHI_STATE.put(`plan:${now.date}`, JSON.stringify(plan), { expirationTtl: 172800 });
    }
    await recordEvent(env, "last_run", { phase: "scheduled-finish", result });
    return result;
  }
  const result = { ok: true, skipped: "nothing-due" };
  await recordEvent(env, "last_run", { phase: "scheduled-finish", result });
  return result;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await scheduledRun(env);
      } catch (e) {
        await recordEvent(env, "last_error", {
          phase: "scheduled-handler",
          message: String(e?.message || e),
        });
      }
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/image/")) {
      const stem = decodeURIComponent(url.pathname.slice(7));
      try {
        const bytes = await getImageBytes(stem);
        return new Response(bytes, {
          headers: {
            "content-type": "image/jpeg",
            "cache-control": "public, max-age=300",
          },
        });
      } catch (e) {
        return new Response("not found", { status: 404 });
      }
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "maahi-instagram-worker", time: new Date().toISOString() });
    }

    if (url.pathname === "/publish") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
      const stem = url.searchParams.get("post_id");
      if (!stem) return json({ error: "post_id required" }, 400);
      try { return json(await publishStem(stem, env)); }
      catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }

    if (url.pathname === "/run") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
      try { return json(await scheduledRun(env)); }
      catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }

    return json({ ok: true, endpoints: ["/health", "/image/:stem", "/publish", "/run"] });
  },
};
