// stale-reasoning: OpenCode v2 plugin for encrypted reasoning rejected after an account switch.
// Keep readable summaries of rejected reasoning and allow one immediate retry.
// Correlate responses by the Request object, not the latest request in a session.
// Read structured error fields only and preserve Request options when rebuilding the body.
// Mark every encrypted item in the rejected request: the upstream names only the first it cannot decrypt.
// Marking only that item would require one failed attempt per encrypted item.
// Evict older ids only, never ids carried by the rejected request, so its retry cannot replay rejected content.
// Consume only a recorded rejection with the same error message when deciding to retry.
// This prevents an unrelated concurrent error from consuming another request's retry.
const CODES = new Set(["invalid_encrypted_content", "thinking_signature_invalid"]);
const VERIFY = /^The encrypted content for item (\S+) could not be verified\b/;
const MAX_SESSIONS = 512;
const MAX_IDS = 256;

const sent = new WeakMap(); // Request as sent -> { sessionID, ids }
const foreign = new Map(); // sessionID -> Set of item ids an upstream refused to decrypt (insertion order = LRU)
const pending = new Map(); // sessionID -> error messages of recorded rejections not yet answered by a retry decision
const MAX_PENDING = 8; // per session

const touch = (sessionID, set) => {
  foreign.delete(sessionID);
  foreign.set(sessionID, set);
  while (foreign.size > MAX_SESSIONS) foreign.delete(foreign.keys().next().value);
};

// Item ids to mark foreign, from the structured error only. undefined = not a stale-reasoning rejection.
// A named item the request did not carry marks nothing (the error is not about this request's reasoning).
export function rejectedIds(text, sentIds) {
  let error;
  try { error = JSON.parse(text)?.error; } catch { return undefined; }
  if (!error || typeof error !== "object") return undefined;
  const message = typeof error.message === "string" ? error.message : "";
  const named = VERIFY.exec(message)?.[1]?.replace(/[.,;:]+$/, "");
  if (!CODES.has(error.code) && !named) return undefined;
  if (named && !sentIds.includes(named)) return [];
  return sentIds;
}

const rebuild = (request, text) => {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body: text });
};

export default {
  id: "stale-reasoning",
  async setup(ctx) {
    await ctx.session.hook("http.request", async (event) => {
      if (event.request.method !== "POST") return;
      let body;
      try { body = JSON.parse(await event.request.clone().text()); } catch { return; }
      if (!Array.isArray(body?.input)) return;
      const bad = foreign.get(event.sessionID);
      let dropped = 0;
      if (bad) {
        touch(event.sessionID, bad);
        body.input = body.input.flatMap((item) => {
          if (item?.type !== "reasoning" || !item.encrypted_content || !bad.has(item.id)) return [item];
          dropped++;
          const summary = Array.isArray(item.summary) ? item.summary.filter((s) => s?.text) : [];
          return summary.length ? [{ type: "reasoning", summary }] : [];
        });
      }
      if (dropped) event.request = rebuild(event.request, JSON.stringify(body));
      const ids = body.input.filter((i) => i?.type === "reasoning" && i.encrypted_content && i.id).map((i) => i.id);
      if (ids.length) sent.set(event.request, { sessionID: event.sessionID, ids });
    });
    await ctx.session.hook("http.response", async (event) => {
      if (event.response.status !== 400) return;
      const origin = event.request && sent.get(event.request);
      if (!origin) return;
      const text = await event.response.clone().text();
      const ids = rejectedIds(text, origin.ids);
      if (!ids?.length) return;
      let rejectionMessage = "";
      try { rejectionMessage = String(JSON.parse(text).error.message ?? ""); } catch { /* rejectedIds already parsed it */ }
      const set = foreign.get(origin.sessionID) ?? new Set();
      for (const id of ids) {
        set.delete(id);
        set.add(id);
      }
      // Bound memory by forgetting the oldest ids, never ones this request still carries: they would be replayed.
      const keep = new Set(ids);
      for (const id of set) {
        if (set.size <= MAX_IDS) break;
        if (!keep.has(id)) set.delete(id);
      }
      touch(origin.sessionID, set);
      const messages = pending.get(origin.sessionID) ?? [];
      messages.push(rejectionMessage);
      if (messages.length > MAX_PENDING) messages.shift();
      pending.delete(origin.sessionID);
      pending.set(origin.sessionID, messages);
      while (pending.size > MAX_SESSIONS) pending.delete(pending.keys().next().value);
    });
    await ctx.session.hook("retry", (event) => {
      const messages = pending.get(event.sessionID);
      const i = messages ? messages.indexOf(event.error?.message ?? "") : -1;
      if (i < 0) return;
      messages.splice(i, 1);
      if (!messages.length) pending.delete(event.sessionID);
      if (event.error?.status === 400 && event.attempt <= 2) event.decision = { retry: true, delay: 0 };
    });
  },
};
