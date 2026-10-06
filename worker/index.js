import { getGoogleDriveAccessToken } from "./google-auth.js";
import {
  buildDriveQueueWithToken,
  listGoogleDriveFilesWithToken,
  readGoogleDriveTextWithToken,
} from "./google-drive.js";

const GRAPH_BASE = "https://graph.instagram.com/v25.0";
const META_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PROCESSING_BACKOFF_MS = [15000, 30000, 60000, 60000];

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
    await env.MAAHI_STATE.put(
      key,
      JSON.stringify({ at: new Date().toISOString(), ...payload }),
      { expirationTtl: 604800 }
    );
  } catch (_) {}
}

async function getMetaCooldown(env) {
  const raw = await env.MAAHI_STATE.get("meta:cooldown_until");
  const until = Number(raw || 0);
  if (!until || until <= Date.now()) {
    if (raw) await env.MAAHI_STATE.delete("meta:cooldown_until");
    return null;
  }
  return until;
}

async function setMetaCooldown(env, reason) {
  const until = Date.now() + META_COOLDOWN_MS;
  await env.MAAHI_STATE.put("meta:cooldown_until", String(until), {
    expirationTtl: Math.ceil(META_COOLDOWN_MS / 1000) + 300,
  });
  await recordEvent(env, "meta:cooldown", {
    until: new Date(until).toISOString(),
    reason,
  });
  return until;
}

function metaRestrictionFromPayload(payload) {
  const err = payload?.error;
  if (!err) return false;
  return (
    err.code === 4 ||
    err.error_subcode === 2207051 ||
    /action is blocked|application request limit reached/i.test(err.message || "")
  );
}

async function getDriveQueue(env) {
  const accessToken = await getGoogleDriveAccessToken(env);
  const queue = await buildDriveQueueWithToken(env, accessToken);
  return { accessToken, queue };
}

async function getCaption(item, accessToken) {
  return readGoogleDriveTextWithToken(item.captionId, accessToken);
}

async function getDriveImageResponse(fileId, env) {
  const accessToken = await getGoogleDriveAccessToken(env);
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    cf: {
      cacheTtl: 300,
      cacheEverything: true,
      image: {
        format: "jpeg",
        quality: 95,
        "origin-auth": "share-publicly",
      },
    },
  });

  if (!r.ok) {
    throw new Error(`Drive image ${fileId}: ${r.status} ${await r.text()}`);
  }

  const contentType = (r.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/jpeg")) {
    throw new Error(
      `Drive image transform did not return JPEG for ${fileId}; content-type=${contentType || "missing"}; cf-resized=${r.headers.get("cf-resized") || "missing"}`
    );
  }

  return new Response(r.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    },
  });
}

async function igPost(url, body, env) {
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS}` },
    body: new URLSearchParams(body),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!r.ok || !data.id) {
    if (metaRestrictionFromPayload(data)) {
      const until = await setMetaCooldown(env, text);
      const error = new Error(`Meta cooldown active until ${new Date(until).toISOString()}: ${text}`);
      error.metaCooldown = true;
      throw error;
    }
    throw new Error(`Instagram ${r.status}: ${text}`);
  }
  return data;
}

async function publishStem(stem, env) {
  let phase = "start";

  try {
    const cooldownUntil = await getMetaCooldown(env);
    if (cooldownUntil) {
      return {
        ok: false,
        skipped: "meta-cooldown",
        cooldown_until: new Date(cooldownUntil).toISOString(),
        stem,
      };
    }

    phase = "list-drive-queue";
    const { accessToken, queue } = await getDriveQueue(env);
    const item = queue.find((x) => x.stem === stem || x.stem.startsWith(`${stem}_`));
    if (!item) throw new Error(`Drive queue item not found: ${stem}`);
    stem = item.stem;

    phase = "check-posted";
    const done = await env.MAAHI_STATE.get(`posted:${stem}`);
    if (done) {
      return { ok: true, skipped: "already-marked", stem, media_id: done };
    }

    phase = "caption";
    const caption = await getCaption(item, accessToken);
    if (!caption) throw new Error(`Caption is empty: ${item.captionName}`);

    const leaseKey = `lease:${stem}`;
    phase = "lease";
    const lease = await env.MAAHI_STATE.get(leaseKey);
    if (lease) return { ok: false, skipped: "lease-active", stem };
    await env.MAAHI_STATE.put(leaseKey, String(Date.now()), { expirationTtl: 900 });

    try {
      phase = "create-container";
      const imageUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/drive-image/${encodeURIComponent(item.imageId)}`;
      const container = await igPost(
        `${GRAPH_BASE}/${env.IG_USER_ID}/media`,
        { image_url: imageUrl, caption },
        env
      );

      phase = "wait-processing";
      let finished = false;
      for (const delayMs of PROCESSING_BACKOFF_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        const u = new URL(`${GRAPH_BASE}/${container.id}`);
        u.searchParams.set("fields", "status_code,status");
        const r = await fetch(u, {
          headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS}` },
        });
        const text = await r.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = {};
        }

        if (!r.ok) {
          if (metaRestrictionFromPayload(data)) {
            const until = await setMetaCooldown(env, text);
            throw new Error(`Meta cooldown active until ${new Date(until).toISOString()}: ${text}`);
          }
          throw new Error(`Instagram processing lookup ${r.status}: ${text}`);
        }
        if (data.status_code === "FINISHED") {
          finished = true;
          break;
        }
        if (["ERROR", "EXPIRED"].includes(data.status_code)) {
          throw new Error(`Instagram processing ${data.status_code}: ${text}`);
        }
      }

      if (!finished) {
        throw new Error("Instagram processing did not finish within safe polling window");
      }

      phase = "publish-container";
      const published = await igPost(
        `${GRAPH_BASE}/${env.IG_USER_ID}/media_publish`,
        { creation_id: container.id },
        env
      );

      await env.MAAHI_STATE.put(`posted:${stem}`, published.id);
      await env.MAAHI_STATE.delete(leaseKey);
      await recordEvent(env, "last_success", {
        stem,
        phase: "published",
        media_id: published.id,
      });
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

  // Conservative rollout: at most one Instagram post per day.
  const count = randInt(1, 100) <= 20 ? 0 : 1;
  const slots = [];
  if (count === 1) {
    slots.push({
      minute: randInt(minutesOfDay("10:00"), minutesOfDay("20:30")),
      done: false,
      post_id: null,
    });
  }

  const plan = { date: now.date, slots };
  await env.MAAHI_STATE.put(key, JSON.stringify(plan), { expirationTtl: 172800 });
  return plan;
}

async function scheduledRun(env) {
  await recordEvent(env, "last_run", { phase: "scheduled-start" });

  const cooldownUntil = await getMetaCooldown(env);
  if (cooldownUntil) {
    const result = {
      ok: true,
      skipped: "meta-cooldown",
      cooldown_until: new Date(cooldownUntil).toISOString(),
    };
    await recordEvent(env, "last_run", { phase: "scheduled-finish", result });
    return result;
  }

  const now = pacificParts();
  const plan = await ensureDailyPlan(env);
  const currentMinute = minutesOfDay(now.time);
  const { queue } = await getDriveQueue(env);
  const available = [];

  for (const item of queue) {
    if (!(await env.MAAHI_STATE.get(`posted:${item.stem}`))) {
      available.push(item.stem);
    }
  }

  for (let i = 0; i < plan.slots.length; i++) {
    const slot = plan.slots[i];
    if (slot.done || currentMinute < slot.minute || available.length === 0) continue;

    const stem = available[randInt(0, available.length - 1)];
    const result = await publishStem(stem, env);

    if (result.ok && !result.skipped) {
      slot.done = true;
      slot.post_id = result.stem;
      await env.MAAHI_STATE.put(
        `plan:${now.date}`,
        JSON.stringify(plan),
        { expirationTtl: 172800 }
      );
    }

    await recordEvent(env, "last_run", {
      phase: "scheduled-finish",
      result,
    });
    return result;
  }

  const result = { ok: true, skipped: "nothing-due", available: available.length };
  await recordEvent(env, "last_run", { phase: "scheduled-finish", result });
  return result;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await scheduledRun(env);
        } catch (e) {
          await recordEvent(env, "last_error", {
            phase: "scheduled-handler",
            message: String(e?.message || e),
          });
        }
      })()
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/test-drive") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return json({ error: "unauthorized" }, 401);
      }

      try {
        const accessToken = await getGoogleDriveAccessToken(env);
        const rootFiles = await listGoogleDriveFilesWithToken(env, accessToken);
        const queue = await buildDriveQueueWithToken(env, accessToken);
        const cooldownUntil = await getMetaCooldown(env);
        return json({
          ok: true,
          folder_id: env.GOOGLE_DRIVE_FOLDER_ID,
          root_file_count: rootFiles.length,
          root_files: rootFiles,
          matched_queue_count: queue.length,
          meta_cooldown_until: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
          queue,
        });
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    if (url.pathname.startsWith("/drive-image/")) {
      const fileId = decodeURIComponent(url.pathname.slice("/drive-image/".length));
      try {
        return await getDriveImageResponse(fileId, env);
      } catch (e) {
        return new Response(String(e?.message || e), { status: 502 });
      }
    }

    if (url.pathname === "/health") {
      const cooldownUntil = await getMetaCooldown(env);
      return json({
        ok: true,
        service: "maahi-instagram-worker",
        source: "google-drive",
        meta_cooldown_until: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === "/publish") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      const stem = url.searchParams.get("post_id");
      if (!stem) return json({ error: "post_id required" }, 400);

      try {
        return json(await publishStem(stem, env));
      } catch (e) {
        return json({ error: String(e?.message || e) }, 500);
      }
    }

    if (url.pathname === "/run") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        return json(await scheduledRun(env));
      } catch (e) {
        return json({ error: String(e?.message || e) }, 500);
      }
    }

    return json({
      ok: true,
      source: "google-drive",
      endpoints: [
        "/health",
        "/test-drive",
        "/drive-image/:fileId",
        "/publish",
        "/run",
      ],
    });
  },
};
