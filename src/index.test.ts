import { describe, it, expect, vi } from "vitest";
import type { ScopedCoreApi, ObsRecord, ObsExporter } from "@voidrift/core";
import {
  register,
  createExporter,
  toGeneration,
  toObservation,
  isGeneration,
  validateConfig,
  resolveOptionsConfig,
  hostError,
  TraceSampler,
  type LangfuseClient,
  type TracePayload,
  type GenerationPayload,
  type ObservationPayload,
  type LangfuseExporterConfig,
} from "./index.js";

// ── a mock Langfuse client that records every emitted payload (OFFLINE) ───────

function makeMockClient() {
  const traces: TracePayload[] = [];
  const generations: GenerationPayload[] = [];
  const observations: ObservationPayload[] = [];
  let flushed = 0;
  let shutdowns = 0;
  const client: LangfuseClient = {
    trace: (p) => void traces.push(p),
    generation: (p) => void generations.push(p),
    observation: (p) => void observations.push(p),
    flush: () => {
      flushed++;
      return Promise.resolve();
    },
    shutdown: () => {
      shutdowns++;
      return Promise.resolve();
    },
  };
  return {
    client,
    traces,
    generations,
    observations,
    get flushed() {
      return flushed;
    },
    get shutdowns() {
      return shutdowns;
    },
  };
}

/** A minimal in-memory stub of the scoped CoreAPI exporter seam. */
function makeCoreStub() {
  const exporters: ObsExporter[] = [];
  const core = {
    pluginId: "@voidrift/plugin-langfuse-exporter",
    register: {
      exporter: (e: unknown) => void exporters.push(e as ObsExporter),
    },
  } as unknown as ScopedCoreApi;
  return { core, exporters };
}

const CONFIG: LangfuseExporterConfig = {
  publicKey: "pk-resolved-from-env",
  secretKey: "sk-resolved-from-env",
  host: "https://langfuse.internal.example",
};

/** Env the host-supplied config references by NAME (FX-C2). */
const ENV = {
  LANGFUSE_PUBLIC_KEY: "pk-resolved-from-env",
  LANGFUSE_SECRET_KEY: "sk-resolved-from-env",
};
/** The options-config the host passes to register: env NAMES, never literals. */
const OPTS_CONFIG = { host: "https://langfuse.internal.example" };

const SESSION = "sess-trace-1";

function modelRecord(over: Partial<ObsRecord> = {}): ObsRecord {
  return {
    traceId: SESSION,
    spanId: "span-model",
    timestamp: "2026-10-10T00:00:00.000Z",
    durationMs: 1200,
    status: "ok",
    source: "model",
    name: "model.stream",
    severity: "verbose",
    attributes: { cost: 0.0042 },
    model: { name: "gpt-4o", protocol: "openai" },
    input: [{ role: "user", content: "hello" }],
    output: "hi there",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 10 },
    ...over,
  };
}

function toolRecord(over: Partial<ObsRecord> = {}): ObsRecord {
  return {
    traceId: SESSION,
    spanId: "span-tool",
    parentSpanId: "span-model",
    timestamp: "2026-10-10T00:00:00.500Z",
    durationMs: 100,
    status: "ok",
    source: "tool",
    name: "read_file",
    severity: "verbose",
    attributes: { path: "/x" },
    input: { path: "/x" },
    output: "contents",
    ...over,
  };
}

// ── §1 registration + routing + disable ──────────────────────────────────────

describe("§1 registration", () => {
  it("registers one ObsExporter via register.exporter and routes each record to it", () => {
    const { core, exporters } = makeCoreStub();
    const mock = makeMockClient();
    register(core, { config: OPTS_CONFIG, env: ENV, clientFactory: () => mock.client, warn: () => {} });
    expect(exporters).toHaveLength(1);

    void exporters[0]!.export(modelRecord());
    void exporters[0]!.export(toolRecord());
    expect(mock.generations).toHaveLength(1);
    expect(mock.observations).toHaveLength(1);
  });

  it("teardown flushes then shuts the client down (hot-disable loses nothing)", async () => {
    const { core } = makeCoreStub();
    const mock = makeMockClient();
    const teardown = register(core, { config: OPTS_CONFIG, env: ENV, clientFactory: () => mock.client, warn: () => {} });
    await teardown!();
    expect(mock.flushed).toBe(1);
    expect(mock.shutdowns).toBe(1);
  });
});

// ── §2 the ObsRecord → trace/generation/observation mapping ──────────────────

describe("§2 mapping", () => {
  it("a model record → a GENERATION with model name, input/output, usageDetails and costDetails", () => {
    const g = toGeneration(modelRecord());
    expect(isGeneration(modelRecord())).toBe(true);
    expect(g.model).toBe("gpt-4o");
    expect(g.metadata["protocol"]).toBe("openai");
    expect(g.input).toEqual([{ role: "user", content: "hello" }]);
    expect(g.output).toBe("hi there");
    expect(g.usageDetails).toEqual({ input: 100, output: 50, total: 150, cacheRead: 10 });
    expect(g.costDetails).toEqual({ total: 0.0042 });
    expect(g.endTime).toBe("2026-10-10T00:00:01.200Z");
  });

  it("a priced model carries costDetails; an unpriced one carries usage only", () => {
    const unpriced = toGeneration(modelRecord({ attributes: {} }));
    expect(unpriced.costDetails).toBeUndefined();
    expect(unpriced.usageDetails).toEqual({ input: 100, output: 50, total: 150, cacheRead: 10 });
  });

  it("a non-model record → an OBSERVATION with no usage and no cost", () => {
    const o = toObservation(toolRecord());
    expect(isGeneration(toolRecord())).toBe(false);
    expect((o as unknown as GenerationPayload).usageDetails).toBeUndefined();
    expect((o as unknown as GenerationPayload).costDetails).toBeUndefined();
    expect(o.name).toBe("read_file");
  });

  it("an error status maps to ERROR level with the message from attributes", () => {
    const g = toObservation(toolRecord({ status: "error", attributes: { message: "boom" } }));
    expect(g.level).toBe("ERROR");
    expect(g.statusMessage).toBe("boom");
  });

  it("a pending span has start only (no endTime)", () => {
    const base = toolRecord({ status: "pending" });
    const pending: typeof base = { ...base };
    delete (pending as { durationMs?: number }).durationMs;
    const o = toObservation(pending);
    expect(o.endTime).toBeUndefined();
    expect(o.startTime).toBe("2026-10-10T00:00:00.500Z");
  });
});

// ── §3 correlation, nesting, already-masked passthrough ──────────────────────

describe("§3 correlation and nesting", () => {
  it("all records of one session share one traceId → one trace; a tool nests under its model generation", () => {
    const { core, exporters } = makeCoreStub();
    const mock = makeMockClient();
    register(core, { config: OPTS_CONFIG, env: ENV, clientFactory: () => mock.client, warn: () => {} });
    void exporters[0]!.export(modelRecord());
    void exporters[0]!.export(toolRecord());

    expect(mock.traces).toHaveLength(1);
    expect(mock.traces[0]!.id).toBe(SESSION);
    expect(mock.generations[0]!.traceId).toBe(SESSION);
    expect(mock.observations[0]!.traceId).toBe(SESSION);
    // the tool observation nests under the model generation by parentSpanId
    expect(mock.observations[0]!.parentObservationId).toBe("span-model");
  });

  it("a parent arriving after its child still nests (parent-by-id)", () => {
    const { core, exporters } = makeCoreStub();
    const mock = makeMockClient();
    register(core, { config: OPTS_CONFIG, env: ENV, clientFactory: () => mock.client, warn: () => {} });
    // child first, parent after — client resolves parent by id
    void exporters[0]!.export(toolRecord());
    void exporters[0]!.export(modelRecord());
    expect(mock.observations[0]!.parentObservationId).toBe("span-model");
    expect(mock.generations[0]!.id).toBe("span-model");
  });

  it("input/output/attributes pass through unaltered — the exporter adds no masking", () => {
    const already = { token: "[REDACTED:token]", path: "/x" };
    const g = toGeneration(modelRecord({ attributes: { ...already, cost: 0.0042 }, input: already }));
    expect(g.input).toEqual(already);
    expect(g.metadata["token"]).toBe("[REDACTED:token]");
  });
});

// ── §4 transport, flush, non-blocking ────────────────────────────────────────

describe("§4 flush and non-blocking export", () => {
  it("export returns synchronously without awaiting the client", () => {
    const mock = makeMockClient();
    const exp = createExporter(mock.client, CONFIG, () => {});
    const r = exp.export(modelRecord());
    expect(r).toBeUndefined();
    expect(mock.generations).toHaveLength(1);
  });

  it("flush awaits the client drain so a headless run exports before exit", async () => {
    const mock = makeMockClient();
    const exp = createExporter(mock.client, CONFIG, () => {});
    await exp.flush();
    expect(mock.flushed).toBe(1);
  });
});

// ── §5 configuration, credentials, sampling ──────────────────────────────────

describe("§5 configuration", () => {
  it("missing credentials makes the exporter no-op with one logged warning and no registration", () => {
    const { core, exporters } = makeCoreStub();
    const warn = vi.fn();
    // env NAMES resolve to nothing: the named env var is not set → disabled.
    const teardown = register(core, { config: { host: "https://x" }, env: {}, warn });
    expect(exporters).toHaveLength(0);
    expect(teardown).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an out-of-range sampling value is rejected as invalid config", () => {
    expect(validateConfig({ publicKey: "p", secretKey: "s", sampling: 2 })).toBeNull();
    expect(validateConfig({ publicKey: "p", secretKey: "s", sampling: 0.5 })).not.toBeNull();
  });

  it("sampling:0 exports nothing (a trace is whole or nothing)", () => {
    const { core, exporters } = makeCoreStub();
    const mock = makeMockClient();
    register(core, { config: { ...OPTS_CONFIG, sampling: 0 }, env: ENV, clientFactory: () => mock.client, warn: () => {} });
    for (const r of [modelRecord(), toolRecord()]) void exporters[0]!.export(r);
    expect(mock.traces).toHaveLength(0);
    expect(mock.generations).toHaveLength(0);
    expect(mock.observations).toHaveLength(0);
  });

  it("sampling is per-trace: a sampled-in trace exports every span", () => {
    const sampler = new TraceSampler(1.0);
    expect(sampler.admit("a")).toBe(true);
    expect(sampler.admit("a")).toBe(true); // stable per trace
  });

  it("host targets a self-hosted endpoint and no secret leaks into any emitted payload", () => {
    const { core, exporters } = makeCoreStub();
    const mock = makeMockClient();
    register(core, { config: OPTS_CONFIG, env: ENV, clientFactory: () => mock.client, warn: () => {} });
    void exporters[0]!.export(modelRecord());
    void exporters[0]!.export(toolRecord());
    const emitted = JSON.stringify([mock.traces, mock.generations, mock.observations]);
    expect(emitted).not.toContain(CONFIG.publicKey);
    expect(emitted).not.toContain(CONFIG.secretKey);
    expect(emitted).not.toContain("https://langfuse.internal.example");
  });
});

// ── §6 failure isolation ─────────────────────────────────────────────────────

describe("§6 failure isolation", () => {
  it("a throwing export is caught, warned, and never stops the turn", () => {
    const warn = vi.fn();
    const client: LangfuseClient = {
      trace: () => {},
      generation: () => {
        throw new Error("network down");
      },
      observation: () => {},
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    const exp = createExporter(client, CONFIG, warn);
    expect(() => exp.export(modelRecord())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a throwing flush is caught and warned, never rejecting into the core", async () => {
    const warn = vi.fn();
    const client: LangfuseClient = {
      trace: () => {},
      generation: () => {},
      observation: () => {},
      flush: () => {
        throw new Error("drain failed");
      },
      shutdown: () => Promise.resolve(),
    };
    const exp = createExporter(client, CONFIG, warn);
    await expect(exp.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("C4 — Langfuse host endpoint validation", () => {
  it("accepts an absent host, loopback http, and any https", () => {
    expect(hostError(undefined)).toBeNull();
    expect(hostError("http://localhost:3000")).toBeNull();
    expect(hostError("http://127.0.0.1:3000")).toBeNull();
    expect(hostError("https://cloud.langfuse.com")).toBeNull();
  });

  it("rejects plaintext http to a non-loopback host", () => {
    expect(hostError("http://langfuse.example.com")).toMatch(/must use https/);
  });

  it("rejects credentials in the host URL without echoing the userinfo", () => {
    const reason = hostError("https://user:sup3rsecret@langfuse.example.com");
    expect(reason).not.toBeNull();
    expect(reason!).not.toContain("sup3rsecret");
    expect(reason!).not.toContain("langfuse.example.com");
  });

  it("validateConfig returns null for a bad host even with valid credentials", () => {
    expect(
      validateConfig({ publicKey: "pk", secretKey: "sk", host: "http://langfuse.example.com" }),
    ).toBeNull();
    // A good https host passes.
    expect(
      validateConfig({ publicKey: "pk", secretKey: "sk", host: "https://cloud.langfuse.com" }),
    ).not.toBeNull();
  });

  it("register warns naming the host failure and registers nothing on a bad host", () => {
    const warn = vi.fn();
    const exporter = vi.fn();
    const core = { register: { exporter } } as unknown as ScopedCoreApi;
    const teardown = register(core, {
      config: { host: "http://langfuse.example.com" },
      env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
      warn,
    });
    expect(teardown).toBeUndefined();
    expect(exporter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/host/);
    expect(warn.mock.calls[0]![0]).not.toContain("langfuse.example.com");
  });

  it("hostError refuses a cloud-metadata endpoint even over https (via the predicate)", () => {
    const isMeta = (h: string) => h === "169.254.169.254" || h === "metadata.google.internal";
    expect(hostError("https://169.254.169.254", isMeta)).toMatch(/cloud instance-metadata/);
    expect(hostError("https://metadata.google.internal/api", isMeta)).toMatch(/cloud instance-metadata/);
    // Without the predicate the default is "not metadata", so https is accepted.
    expect(hostError("https://169.254.169.254")).toBeNull();
  });

  it("register refuses a metadata endpoint via core.network and registers nothing, naming the host", () => {
    const warn = vi.fn();
    const exporter = vi.fn();
    const core = {
      register: { exporter },
      network: { isMetadataHost: (h: string) => h === "169.254.169.254" },
    } as unknown as ScopedCoreApi;
    const teardown = register(core, {
      config: { host: "https://169.254.169.254/api/public/ingestion" },
      env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
      warn,
    });
    expect(teardown).toBeUndefined();
    expect(exporter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain("cloud instance-metadata");
    expect(msg).toContain("169.254.169.254");
    expect(msg).not.toContain("https://");
    expect(msg).not.toContain("/api/public/ingestion");
  });
});

describe("FX-C2 — credentials come from env var NAMES, never literals", () => {
  it("rejects a literal publicKey/secretKey with a clear validation reason", () => {
    const warn = vi.fn();
    const exporter = vi.fn();
    const core = { register: { exporter } } as unknown as ScopedCoreApi;
    // A host that still passes a literal secret is rejected, not ignored.
    const teardown = register(core, {
      config: { publicKey: "pk-literal", secretKey: "sk-literal" } as never,
      env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
      warn,
    });
    expect(teardown).toBeUndefined();
    expect(exporter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/secrets belong in environment variables; set publicKeyEnv\/secretKeyEnv/);
    // The literal secret never appears in the warning.
    expect(warn.mock.calls[0]![0]).not.toContain("pk-literal");
    expect(warn.mock.calls[0]![0]).not.toContain("sk-literal");
  });

  it("resolves the default env var names when none are given", () => {
    const { core, exporters } = makeCoreStub();
    const mock = makeMockClient();
    register(core, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-env", LANGFUSE_SECRET_KEY: "sk-env" },
      clientFactory: () => mock.client,
      warn: () => {},
    });
    expect(exporters).toHaveLength(1);
  });

  it("honors custom env var names", () => {
    const res = resolveOptionsConfig(
      { publicKeyEnv: "LF_PUB", secretKeyEnv: "LF_SEC" },
      { LF_PUB: "pk", LF_SEC: "sk" },
    );
    expect(res.config).not.toBeNull();
    expect(res.config!.publicKey).toBe("pk");
    expect(res.config!.secretKey).toBe("sk");
  });

  it("a missing env var disables the exporter with a reason and never throws", () => {
    const warn = vi.fn();
    const { core, exporters } = makeCoreStub();
    const teardown = register(core, {
      config: { secretKeyEnv: "LANGFUSE_SECRET_KEY" },
      env: { LANGFUSE_SECRET_KEY: "sk" }, // public key env absent
      warn,
    });
    expect(teardown).toBeUndefined();
    expect(exporters).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/LANGFUSE_PUBLIC_KEY is not set/);
  });
});
