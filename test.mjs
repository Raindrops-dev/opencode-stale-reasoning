// Offline tests for stale-reasoning. Run: node test.mjs. Exit 0 = PASS.
// Check selective cleanup, retry decisions, Request correlation, and memory limits.
// A rejection marks every encrypted item in that request, not only the first item the upstream names.
import plugin, { rejectedIds } from "./index.mjs";
const hooks = {};
await plugin.setup({ session: { hook: async (name, cb) => { hooks[name] = cb; } } });
let fails = 0;
const check = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const mk = (input, sid = "s1", init = {}) => ({ sessionID: sid, kind: "primary",
  request: new Request("http://x/v1/responses", { method: "POST", body: JSON.stringify({ input }), ...init }) });
const send = async (e) => { await hooks["http.request"](e); return e; };
const reject = (e, body) => hooks["http.response"]({ sessionID: e.sessionID, request: e.request, response: new Response(body, { status: 400 }) });
const named = (id) => JSON.stringify({ error: { code: "invalid_encrypted_content", message: `The encrypted content for item ${id} could not be verified. Reason: Encrypted content could not be decrypted or parsed.`, type: "invalid_request_error" } });
const bodyOf = async (e) => JSON.parse(await e.request.clone().text());
const r = (id, enc, text) => ({ type: "reasoning", id, encrypted_content: enc, summary: text ? [{ type: "summary_text", text }] : [] });
const U = { role: "user", content: "hi" };
const A = r("rs_A", "gAAAA-a", "kept text"), B = r("rs_B", "gAAAA-b"), C = r("rs_C", "gAAAA-c");

// 1-3 untouched before any rejection; retry decision
let e = mk([U, A]); const before = e.request; await send(e);
check(e.request === before, "1 no rejection yet: request untouched");
await reject(e, named("rs_A"));
const msgA = JSON.parse(named("rs_A")).error.message;
const d2 = { sessionID: "s1", attempt: 2, error: { status: 400, message: msgA }, decision: { retry: false } };
hooks.retry(d2); check(d2.decision.retry === true, "2 retry hook allows one retry after a recorded rejection");
const d3 = { ...d2, attempt: 3, decision: { retry: false } }; hooks.retry(d3);
check(d3.decision.retry === false, "3 no second retry without a new recorded rejection");
// 4-6 repair
e = await send(mk([U, A, B]));
const b4 = await bodyOf(e);
const ra = b4.input.find((i) => i.type === "reasoning" && i.summary?.[0]?.text === "kept text");
check(ra && !ra.encrypted_content && !ra.id, "4 foreign item: ciphertext and id dropped, summary kept");
check(b4.input.some((i) => i.id === "rs_B" && i.encrypted_content === "gAAAA-b"), "5 item not in the rejected request kept (made later)");
check(!e.request.headers.has("content-length"), "6 content-length removed after body rewrite");
// 7-8 other sessions, unrelated 400
e = mk([U, A], "s2"); const b7 = e.request; await send(e); check(e.request === b7, "7 other session untouched");
await reject(e, JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }));
e = mk([U, A], "s2"); const b8 = e.request; await send(e); check(e.request === b8, "8 unrelated 400 does not mark");
// 9 coded error without a named item marks all sent items; item without summary removed
e = await send(mk([U, C], "s4")); await reject(e, JSON.stringify({ error: { code: "thinking_signature_invalid", message: "Invalid signature" } }));
e = await send(mk([U, C], "s4"));
check((await bodyOf(e)).input.every((i) => i.type !== "reasoning"), "9 coded error marks sent items; item without summary removed");

// 10-11 correlate by Request despite intervening or concurrent requests in the same session
let p = await send(mk([U, A], "s5"));
await send({ ...mk([U], "s5"), kind: "title" });
await reject(p, named("rs_A"));
e = await send(mk([U, A], "s5"));
check(!(await bodyOf(e)).input.some((i) => i.id === "rs_A"), "10 race: intervening title request does not hide the rejected item");
p = await send(mk([U, A], "s6")); const g = await send({ ...mk([U, B], "s6"), kind: "generate" });
await reject(p, named("rs_A")); void g;
e = await send(mk([U, A, B], "s6")); const b11 = await bodyOf(e);
check(!b11.input.some((i) => i.id === "rs_A") && b11.input.some((i) => i.id === "rs_B"), "11 race: failed A repaired, concurrent B preserved");
// 12 every encrypted item of the rejected request is marked (one retry recovers), later items kept
p = await send(mk([U, A, B], "s7")); await reject(p, named("rs_A"));
e = await send(mk([U, A, B, C], "s7")); const b12 = await bodyOf(e);
check(!b12.input.some((i) => i.id === "rs_A" || i.id === "rs_B") && b12.input.some((i) => i.id === "rs_C" && i.encrypted_content), "12 all items of the rejected request marked; later item kept");
// 13 an echoed diagnostic is not a rejection
p = await send(mk([U, A], "s8"));
await reject(p, JSON.stringify({ error: { code: "invalid_value", message: "Unsupported metadata value: invalid_encrypted_content" } }));
e = mk([U, A], "s8"); const b13 = e.request; await send(e);
check(e.request === b13, "13 unrelated diagnostic mentioning the error text does not strip");
// 14 rebuilding preserves Request options
p = await send(mk([U, A], "s9")); await reject(p, named("rs_A"));
e = await send(mk([U, A], "s9", { redirect: "error" }));
check(e.request.redirect === "error", "14 rewrite preserves redirect:error");
// 15 an active session survives eviction by idle sessions
p = await send(mk([U, A], "keep")); await reject(p, named("rs_A"));
for (let i = 0; i < 600; i++) {
  if (i % 50 === 0) await send(mk([U], "keep"));
  const x = await send(mk([U, r(`rs_x${i}`, "gAAAA-x")], `idle${i}`)); await reject(x, named(`rs_x${i}`));
}
e = await send(mk([U, A], "keep"));
check(!(await bodyOf(e)).input.some((i) => i.id === "rs_A"), "15 active foreign session survives idle-session eviction");
// 16 older ids are evicted when the per-session set exceeds its target
p = { sessionID: "big" };
for (let i = 0; i < 400; i++) { const x = await send(mk([U, r(`rs_b${i}`, "gAAAA")], "big")); await reject(x, named(`rs_b${i}`)); }
e = await send(mk([U, r("rs_b0", "gAAAA"), r("rs_b399", "gAAAA")], "big")); const b16 = await bodyOf(e);
check(b16.input.some((i) => i.id === "rs_b0") && !b16.input.some((i) => i.id === "rs_b399"), "16 per-session id set bounded (oldest forgotten, newest kept)");
// 18 preserve all ids from a rejected request even when it exceeds the cap
const many = Array.from({ length: 300 }, (_, i) => r(`rs_m${i}`, "gAAAA-m"));
p = await send(mk([U, ...many], "over")); await reject(p, named("rs_m0"));
e = await send(mk([U, ...many], "over"));
check(!(await bodyOf(e)).input.some((i) => i.type === "reasoning" && i.encrypted_content), "18 over-cap request: no foreign ciphertext replayed on retry");
// 19 an unrelated 400 in a repaired session is not retried
p = await send(mk([U, A], "rep")); await reject(p, named("rs_A"));
const d19a = { sessionID: "rep", attempt: 2, error: { status: 400, message: msgA }, decision: { retry: false } }; hooks.retry(d19a);
p = await send(mk([U], "rep")); await reject(p, JSON.stringify({ error: { code: "invalid_value", message: "Unsupported metadata value: invalid_encrypted_content" } }));
const d19 = { sessionID: "rep", attempt: 2, error: { status: 400, message: "Unsupported metadata value: invalid_encrypted_content" }, decision: { retry: false } };
hooks.retry(d19); check(d19.decision.retry === false, "19 unrelated 400 in a repaired session stays terminal");
// 20 a concurrent unrelated 400 cannot consume another request's recorded rejection
p = await send(mk([U, A], "conc")); await reject(p, named("rs_A"));
const gen = await send({ ...mk([U], "conc"), kind: "generate" });
await reject(gen, JSON.stringify({ error: { code: "invalid_value", message: "bad metadata" } }));
const dg = { sessionID: "conc", attempt: 2, error: { status: 400, message: "bad metadata" }, decision: { retry: false } }; hooks.retry(dg);
const dp = { sessionID: "conc", attempt: 2, error: { status: 400, message: msgA }, decision: { retry: false } }; hooks.retry(dp);
check(dg.decision.retry === false && dp.decision.retry === true, "20 concurrent: unrelated 400 not retried, the rejected request still retried");
// 21 stale recorded rejection without a decision does not make a later unrelated 400 retry
p = await send(mk([U, A], "stale")); await reject(p, named("rs_A"));
const du = { sessionID: "stale", attempt: 2, error: { status: 400, message: "Unsupported metadata value: invalid_encrypted_content" }, decision: { retry: false } }; hooks.retry(du);
check(du.decision.retry === false, "21 unconsumed rejection does not leak a retry to an unrelated 400");
// 17 parser unit
check(rejectedIds("not json", ["rs_A"]) === undefined && rejectedIds(named("rs_Z"), ["rs_A"]).length === 0, "17 parser: non-JSON ignored; named id not sent marks nothing");
console.log(fails ? `FAIL: ${fails}` : "PASS: 0 failing");
process.exit(fails ? 1 : 0);
