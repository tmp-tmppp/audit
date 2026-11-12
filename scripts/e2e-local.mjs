// End to end run on one machine: PostgreSQL 18, NATS with JetStream and the audit service run as processes or containers
// (see README, "Run it end to end"); this script plays everybody else: the identity provider (it serves a key set and
// signs tokens, so audit verifies real signatures), the publishers of the four streams (tenants, payments, markets,
// trading) for two tenants, and the owner of the database, who tampers with one row at the end. It prints every step and
// exits 1 at the first one that does not come out as expected.
//
//   node scripts/e2e-local.mjs
// Settings, all optional: AUDIT_URL, NATS_URL, JWKS_PORT, AUTH_ISSUER, AUTH_AUDIENCE (the service's AUTH_JWKS_URL must point
// at http://127.0.0.1:<JWKS_PORT>/), DATABASE_URL (the service's database, as its owner: without it the tamper step is
// skipped, which is all that an in-memory run can do).
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import pg from "pg";

const env = (name, fallback) => process.env[name] ?? fallback;
const AUDIT = env("AUDIT_URL", "http://127.0.0.1:8080");
const NATS = env("NATS_URL", "nats://127.0.0.1:4222");
const JWKS_PORT = Number(env("JWKS_PORT", "8099"));
const ISSUER = env("AUTH_ISSUER", "http://localhost:8081/realms/chance");
const AUDIENCE = env("AUTH_AUDIENCE", "chance");
const DATABASE_URL = env("DATABASE_URL", "");
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const KID = "e2e-key";

const log = (step, text) => console.log(`[${new Date().toISOString()}] ${step}: ${text}`);
const fail = (step, text) => {
  console.error(`[${new Date().toISOString()}] ${step}: FAILED ${text}`);
  process.exitCode = 1;
  throw new Error(`${step}: ${text}`);
};
const expect = (step, condition, text) => {
  if (!condition) fail(step, text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(step, read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) fail(step, "timed out");
    await sleep(250);
  }
}

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
const jwksServer = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
}).listen(JWKS_PORT, "127.0.0.1");
log("identity", `key set on http://127.0.0.1:${JWKS_PORT}/ (audit must have AUTH_JWKS_URL pointing at it)`);

const token = (tenant, roles = ["tenant-admin"]) =>
  new SignJWT({ realm_access: { roles }, ...(tenant === null ? {} : { organization: [tenant] }) })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject("e2e-user")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);

async function api(path, { tenant = TENANT, roles, bearer = true } = {}) {
  const headers = bearer ? { authorization: `Bearer ${await token(tenant, roles)}` } : {};
  const response = await fetch(`${AUDIT}${path}`, { headers });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

const nc = await connect({ servers: NATS });
const manager = await jetstreamManager(nc);
const js = jetstream(nc);
for (const [name, subjects] of [["TENANTS", ["chance.tenants.>"]], ["PAYMENTS", ["chance.payments.>"]], ["MARKETS", ["chance.markets.>"]], ["TRADING", ["chance.trading.>"]]]) {
  try {
    await manager.streams.info(name);
  } catch {
    await manager.streams.add({ name, subjects });
  }
}

// The events carry explicit times (minutes before now), so the "from" and "to" filters have a known answer.
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
const marketId = randomUUID();
const depositId = randomUUID();
const ids = { created: randomUUID(), deposit: randomUUID(), market: randomUUID(), trade: randomUUID(), unknown: randomUUID() };
const idsOther = { created: randomUUID(), deposit: randomUUID(), market: randomUUID(), trade: randomUUID() };
const cloudEvent = (id, type, tenant, data, { correlation = "e2e-corr", time = new Date() } = {}) =>
  new TextEncoder().encode(
    JSON.stringify({ specversion: "1.0", id, type, source: "/chance/e2e", time: time.toISOString(), datacontenttype: "application/json", tenantid: tenant, correlationid: correlation, causationid: randomUUID(), data }),
  );
const TYPES = {
  created: "si.chance.tenants.TenantCreated.v1",
  deposit: "si.chance.payments.DepositSucceeded.v1",
  market: "si.chance.markets.MarketOpened.v1",
  trade: "si.chance.trading.TradeExecuted.v1",
};
const at = { created: minutesAgo(60), deposit: minutesAgo(50), market: minutesAgo(40), trade: minutesAgo(30), unknown: minutesAgo(20) };

async function tamperAsOwner(schema, seq) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // 1. The trigger refuses the change, also from the owner.
    let refused = null;
    try {
      await client.query(`UPDATE "${schema}".audit_entries SET payload = '{"amount": 1}'::jsonb WHERE seq = $1`, [seq]);
    } catch (error) {
      refused = error;
    }
    expect("append-only", refused !== null && refused.code === "23001", `the trigger should refuse an UPDATE with 23001, got ${refused?.code ?? "no error"}`);
    log("append-only", `UPDATE of seq ${seq} by the owner: refused (${refused.code}: ${refused.message})`);
    // 2. Only the owner can switch the trigger off for the length of one statement, and then the chain shows it.
    await client.query("BEGIN");
    await client.query(`ALTER TABLE "${schema}".audit_entries DISABLE TRIGGER audit_entries_append_only`);
    await client.query(`UPDATE "${schema}".audit_entries SET payload = jsonb_set(payload, '{marketId}', '"tampered"') WHERE seq = $1`, [seq]);
    await client.query(`ALTER TABLE "${schema}".audit_entries ENABLE TRIGGER audit_entries_append_only`);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

try {
  // 1. An event of a tenant that does not exist yet is held back (nak with backoff) until its TenantCreated is processed.
  await js.publish(`chance.payments.DepositSucceeded.${TENANT}`, cloudEvent(ids.deposit, TYPES.deposit, TENANT, { depositId, userId: "trader-1", amount: 2500 }, { correlation: "corr-deposit", time: at.deposit }));
  log("payments", `published DepositSucceeded for ${TENANT}, whose TenantCreated is still to come`);
  const early = await api("/v1/audit");
  expect("not ready", early.status === 503 && early.body.code === "tenant_not_ready" && early.headers.get("retry-after") === "5", `expected 503 tenant_not_ready with Retry-After 5, got ${early.status} ${JSON.stringify(early.body)}`);
  log("audit", "no log yet: 503 tenant_not_ready, Retry-After 5");

  // 2. TenantCreated: audit creates the tenant's schema and records it; the held-back deposit follows it.
  await js.publish(`chance.tenants.TenantCreated.${TENANT}`, cloudEvent(ids.created, TYPES.created, TENANT, { tenantId: TENANT, name: "E2E" }, { correlation: "corr-tenant", time: at.created }));
  log("tenants", "published TenantCreated");
  await eventually("TenantCreated recorded", async () => (await api("/v1/audit")).status === 200);
  const marketData = { marketId, adminId: "admin-1", question: "Will it rain?" };
  await js.publish(`chance.markets.MarketOpened.${TENANT}`, cloudEvent(ids.market, TYPES.market, TENANT, marketData, { correlation: "corr-market", time: at.market }));
  await js.publish(`chance.trading.TradeExecuted.${TENANT}`, cloudEvent(ids.trade, TYPES.trade, TENANT, { marketId, userId: "trader-1", amount: 300 }, { correlation: "corr-market", time: at.trade }));
  // A redelivery of an event already sent (the same id), an event type nobody knows, and a message that is no envelope.
  await js.publish(`chance.markets.MarketOpened.${TENANT}`, cloudEvent(ids.market, TYPES.market, TENANT, marketData, { correlation: "corr-market", time: at.market }));
  await js.publish(`chance.markets.WidgetRetired.${TENANT}`, cloudEvent(ids.unknown, "si.chance.future.WidgetRetired.v9", TENANT, ["anything", { goes: true }], { time: at.unknown }));
  await js.publish(`chance.markets.Broken.${TENANT}`, new TextEncoder().encode(JSON.stringify({ specversion: "1.0", id: randomUUID(), type: "t", source: "s" })));
  // The second tenant: one event of each publisher, with its own ids and its own log.
  const otherMarket = randomUUID();
  await js.publish(`chance.tenants.TenantCreated.${OTHER_TENANT}`, cloudEvent(idsOther.created, TYPES.created, OTHER_TENANT, { tenantId: OTHER_TENANT, name: "Other" }, { correlation: "corr-other" }));
  await js.publish(`chance.payments.DepositSucceeded.${OTHER_TENANT}`, cloudEvent(idsOther.deposit, TYPES.deposit, OTHER_TENANT, { depositId: randomUUID(), userId: "trader-9", amount: 100 }, { correlation: "corr-other" }));
  await js.publish(`chance.markets.MarketOpened.${OTHER_TENANT}`, cloudEvent(idsOther.market, TYPES.market, OTHER_TENANT, { marketId: otherMarket, adminId: "admin-9", question: "Other?" }, { correlation: "corr-market" }));
  await js.publish(`chance.trading.TradeExecuted.${OTHER_TENANT}`, cloudEvent(idsOther.trade, TYPES.trade, OTHER_TENANT, { marketId: otherMarket, userId: "trader-9", amount: 5 }, { correlation: "corr-market" }));
  log("events", "published a market, a trade, a duplicate, an unknown type and a broken message for tenant A, and one event of each publisher for tenant B");

  const all = await eventually("five entries", async () => {
    const page = await api("/v1/audit?limit=100");
    return page.status === 200 && page.body.items.length === 5 ? page.body.items : null;
  });
  await sleep(1500); // the duplicate and the broken message must not add anything
  const settled = (await api("/v1/audit?limit=100")).body.items;
  expect("entries", settled.length === 5, `expected 5 entries (the duplicate and the broken message are not entries), got ${settled.length}`);
  const bySeq = [...all].reverse();
  expect("order", bySeq.map((entry) => entry.seq).join() === "1,2,3,4,5", `seq is not 1..5: ${bySeq.map((entry) => entry.seq)}`);
  expect("order", bySeq[0].eventId === ids.created, "TenantCreated is not the first entry");
  expect("hash chain", bySeq[0].prevHash === "0".repeat(64) && bySeq.every((entry, n) => n === 0 || entry.prevHash === bySeq[n - 1].hash), "the hashes do not chain");
  log("audit", `newest first: ${all.map((entry) => `${entry.seq}:${entry.eventType.split(".").slice(-2).join(".")}`).join(", ")}`);
  const unknown = all.find((entry) => entry.eventId === ids.unknown);
  expect("unknown type", unknown && unknown.subject === TENANT && Array.isArray(unknown.payload), "an unknown event type was not recorded as received");
  const deposit = all.find((entry) => entry.eventId === ids.deposit);
  expect("deposit", deposit && deposit.subject === depositId && deposit.actor === "trader-1" && deposit.seq > 1, `the held-back deposit is wrong: ${JSON.stringify(deposit)}`);
  log("audit", `the deposit came after TenantCreated (seq ${deposit.seq}), subject ${deposit.subject}, actor ${deposit.actor}`);

  // 3. The API as the admin of tenant A: only A's entries, filters, cursor, verify, and who may call it.
  const foreign = new Set(Object.values(idsOther));
  expect("isolation", all.every((entry) => !foreign.has(entry.eventId)), "tenant A's log holds an event of tenant B");
  const byCorrelation = await api("/v1/audit?correlationId=corr-market");
  expect("filter", byCorrelation.body.items.length === 2, `correlationId=corr-market should match 2 entries (tenant B has the same correlation id and must not show), got ${byCorrelation.body.items.length}`);
  const byType = await api(`/v1/audit?type=${TYPES.market},${TYPES.trade}&subject=${marketId}`);
  expect("filter", byType.body.items.length === 2, `type and subject should match 2 entries, got ${byType.body.items.length}`);
  const byRepeatedType = await api(`/v1/audit?type=${TYPES.created}&type=${TYPES.deposit}`);
  expect("filter", byRepeatedType.body.items.length === 2, `a repeated type should match 2 entries, got ${byRepeatedType.body.items.length}`);
  const from = encodeURIComponent(minutesAgo(35).toISOString());
  const to = encodeURIComponent(minutesAgo(25).toISOString());
  const sinceThen = await api(`/v1/audit?from=${from}`);
  expect("filter", sinceThen.body.items.map((entry) => entry.eventId).sort().join() === [ids.trade, ids.unknown].sort().join(), `from (35 minutes ago) should match the trade and the unknown event, got ${sinceThen.body.items.length} entries`);
  const window = await api(`/v1/audit?from=${from}&to=${to}`);
  expect("filter", window.body.items.length === 1 && window.body.items[0].eventId === ids.trade, `from and to should match the trade only, got ${window.body.items.length} entries`);
  const byActor = await api("/v1/audit?actor=trader-1");
  expect("filter", byActor.body.items.length === 2, `actor=trader-1 should match 2 entries, got ${byActor.body.items.length}`);
  const first = await api("/v1/audit?limit=2");
  const second = await api(`/v1/audit?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
  expect("cursor", first.body.items.length === 2 && second.body.items.length === 2 && first.body.items.at(-1).seq > second.body.items[0].seq, "the cursor did not continue after the first page");
  log("audit", "filters (type comma list and repeated, correlationId, subject, actor, from, from+to) and the cursor work, and tenant B's events do not show");
  const verified = await api("/v1/audit/verify");
  expect("verify", verified.status === 200 && verified.body.valid === true && verified.body.entries === 5 && verified.body.brokenAtSeq === null, `verify: ${JSON.stringify(verified.body)}`);
  log("audit", `verify of tenant A: ${JSON.stringify(verified.body)}`);

  const noToken = await api("/v1/audit", { bearer: false });
  const trader = await api("/v1/audit", { roles: ["trader"] });
  const traderVerify = await api("/v1/audit/verify", { roles: ["trader"] });
  const noTenant = await api("/v1/audit", { tenant: null });
  expect("auth", noToken.status === 401 && trader.status === 403 && traderVerify.status === 403 && noTenant.status === 403, `expected 401, 403, 403, 403, got ${noToken.status}, ${trader.status}, ${traderVerify.status}, ${noTenant.status}`);
  log("auth", "no token 401, role trader 403 (list and verify), a token without a tenant 403");
  const other = await eventually("second tenant", async () => {
    const page = await api("/v1/audit?limit=100", { tenant: OTHER_TENANT });
    return page.status === 200 && page.body.items.length === 4 ? page : null;
  });
  expect("isolation", other.body.items.every((entry) => foreign.has(entry.eventId)), `the second tenant sees ${JSON.stringify(other.body.items.map((entry) => entry.eventId))}`);
  const sources = new Set(other.body.items.map((entry) => entry.eventType.split(".")[2]));
  expect("isolation", ["tenants", "payments", "markets", "trading"].every((service) => sources.has(service)), `tenant B misses a publisher: ${[...sources]}`);
  log("isolation", "the admin of tenant B sees its own four entries (one per publisher) and nothing of tenant A's");
  const write = await fetch(`${AUDIT}/v1/audit`, { method: "DELETE", headers: { authorization: `Bearer ${await token(TENANT)}` } });
  expect("append-only", write.status === 404, `DELETE /v1/audit answered ${write.status}, expected 404`);
  log("append-only", "DELETE /v1/audit is 404: there is no route that writes");

  // 4. Tampering at the database, as its owner, and how verify finds it.
  if (DATABASE_URL) {
    const target = all.find((entry) => entry.eventId === ids.market);
    const schema = `tenant_${TENANT.replaceAll("-", "")}`;
    await tamperAsOwner(schema, target.seq);
    log("tamper", `the owner switched the trigger off for one statement and changed the payload of seq ${target.seq} (the market event)`);
    const broken = await api("/v1/audit/verify");
    expect("verify after tampering", broken.status === 200 && broken.body.valid === false && broken.body.brokenAtSeq === target.seq && broken.body.entries === 5, `expected valid=false, brokenAtSeq=${target.seq}, entries=5, got ${JSON.stringify(broken.body)}`);
    log("audit", `verify of tenant A after the tampering: ${JSON.stringify(broken.body)}`);
    const untouched = await api("/v1/audit/verify", { tenant: OTHER_TENANT });
    expect("verify after tampering", untouched.body.valid === true && untouched.body.entries === 4, `tenant B should still verify: ${JSON.stringify(untouched.body)}`);
    log("audit", `verify of tenant B: ${JSON.stringify(untouched.body)}`);
  } else {
    log("tamper", "skipped: DATABASE_URL is not set (an in-memory run has no database to tamper with)");
  }
  log("done", "every step passed");
} finally {
  await nc.drain().catch(() => undefined);
  jwksServer.close();
  jwksServer.closeAllConnections();
}
