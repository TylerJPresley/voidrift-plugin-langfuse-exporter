/**
 * The default HTTPS ingestion client (langfuse-exporter-blueprint §4, §7),
 * exercised through a LOOPBACK ingestion server — no live Langfuse, no network
 * beyond 127.0.0.1. These prove the transport contract the blueprint names:
 * the public ingestion batch shape, Basic auth ONLY to the configured host, no
 * planted secret in any body, a killed receiver never blocking a turn, and a
 * shutdown flush.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createHttpClient, ingestionUrl, basicAuthHeader } from "./http-client.js";
import type { LangfuseExporterConfig, GenerationPayload, ObservationPayload } from "./index.js";

interface Received {
  url: string;
  auth: string | undefined;
  bodies: string[];
}

/** A loopback ingestion server that records what it receives. */
async function startServer(): Promise<{
  host: string;
  received: Received;
  close: () => Promise<void>;
}> {
  const received: Received = { url: "", auth: undefined, bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.url = req.url ?? "";
      received.auth = req.headers["authorization"];
      received.bodies.push(raw);
      res.writeHead(207, { "content-type": "application/json" });
      res.end(JSON.stringify({ successes: [], errors: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    host: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function cfg(host: string): LangfuseExporterConfig {
  return { publicKey: "pk-live-123", secretKey: "sk-live-abcXYZ", host };
}

const gen: GenerationPayload = {
  id: "span-model",
  traceId: "sess-1",
  name: "model.stream",
  startTime: "2026-10-10T00:00:00.000Z",
  endTime: "2026-10-10T00:00:01.200Z",
  level: "DEFAULT",
  model: "gpt-4o",
  input: [{ role: "user", content: "hello" }],
  output: "hi there",
  metadata: { protocol: "openai" },
  usageDetails: { input: 100, output: 50, total: 150 },
};

const obs: ObservationPayload = {
  id: "span-tool",
  traceId: "sess-1",
  parentObservationId: "span-model",
  name: "read_file",
  startTime: "2026-10-10T00:00:00.500Z",
  level: "DEFAULT",
  input: { path: "/x" },
  output: "contents",
  metadata: { path: "/x" },
};

let open: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("default HTTPS ingestion client (§4)", () => {
  it("helpers build the ingestion URL and Basic auth header", () => {
    expect(ingestionUrl("https://cloud.langfuse.com")).toBe("https://cloud.langfuse.com/api/public/ingestion");
    expect(ingestionUrl("https://host/")).toBe("https://host/api/public/ingestion");
    expect(ingestionUrl(undefined)).toBe("https://cloud.langfuse.com/api/public/ingestion");
    expect(basicAuthHeader("pk", "sk")).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
  });

  it("POSTs the public ingestion batch shape to the configured host only, with Basic auth", async () => {
    const srv = await startServer();
    open = srv;
    const client = createHttpClient(cfg(srv.host), {});
    client.trace({ id: "sess-1", name: "session" });
    client.generation(gen);
    client.observation(obs);
    await client.flush();

    expect(srv.received.url).toBe("/api/public/ingestion");
    expect(srv.received.auth).toBe(basicAuthHeader("pk-live-123", "sk-live-abcXYZ"));
    const all = srv.received.bodies.join("");
    const parsed = JSON.parse(srv.received.bodies[0]!) as { batch: { type: string; body: Record<string, unknown> }[] };
    const types = parsed.batch.map((e) => e.type).sort();
    expect(types).toContain("trace-create");
    expect(types).toContain("generation-create");
    expect(types).toContain("span-create");
    // nesting + usage survive onto the ingestion body
    const g = parsed.batch.find((e) => e.type === "generation-create")!.body;
    expect(g["traceId"]).toBe("sess-1");
    expect(g["usageDetails"]).toEqual({ input: 100, output: 50, total: 150 });
    const o = parsed.batch.find((e) => e.type === "span-create")!.body;
    expect(o["parentObservationId"]).toBe("span-model");
    expect(all).not.toContain("pk-live-123");
    expect(all).not.toContain("sk-live-abcXYZ");
  });

  it("no planted secret reaches any request body (auth travels only in the header)", async () => {
    const srv = await startServer();
    open = srv;
    const client = createHttpClient(cfg(srv.host), {});
    client.generation({ ...gen, metadata: { protocol: "openai", note: "ordinary" } });
    await client.flush();
    for (const body of srv.received.bodies) {
      expect(body).not.toContain("pk-live-123");
      expect(body).not.toContain("sk-live-abcXYZ");
    }
  });

  it("a killed receiver never blocks: export enqueues and flush resolves", async () => {
    const srv = await startServer();
    const host = srv.host;
    await srv.close(); // receiver is gone before any send
    const warned: string[] = [];
    const client = createHttpClient(cfg(host), { warn: (m) => warned.push(m) });
    client.trace({ id: "sess-1" });
    client.generation(gen);
    // enqueue returns synchronously; the drain must resolve (never hang/throw)
    await expect(client.flush()).resolves.toBeUndefined();
    expect(warned.some((w) => /flush failed|status/.test(w))).toBe(true);
  });

  it("bounded queue drops the oldest and counts it (§4 back-pressure)", async () => {
    const srv = await startServer();
    const host = srv.host;
    await srv.close();
    const warned: string[] = [];
    const client = createHttpClient(cfg(host), { warn: (m) => warned.push(m), maxQueue: 2, flushIntervalMs: 0 });
    client.trace({ id: "a" });
    client.trace({ id: "b" });
    client.trace({ id: "c" }); // overflows — oldest dropped
    client.trace({ id: "d" });
    await client.flush();
    expect(warned.some((w) => /dropped \d+ event/.test(w))).toBe(true);
  });

  it("shutdown flushes queued events then stops (short run exports before exit)", async () => {
    const srv = await startServer();
    open = srv;
    const client = createHttpClient(cfg(srv.host), {});
    client.trace({ id: "sess-1" });
    client.generation(gen);
    await client.shutdown();
    expect(srv.received.bodies.length).toBeGreaterThan(0);
    const parsed = JSON.parse(srv.received.bodies[0]!) as { batch: unknown[] };
    expect(parsed.batch.length).toBe(2);
  });
});
