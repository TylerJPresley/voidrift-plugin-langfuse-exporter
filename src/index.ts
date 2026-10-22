/**
 * VoidRift Langfuse exporter — a first-party plugin (langfuse-exporter-blueprint.md).
 *
 * It registers one `ObsExporter` through `core.register.exporter` (§10.8, §12.4),
 * receives each neutral `ObsRecord` the core writes, and maps that record onto
 * Langfuse's trace / observation / generation model so a VoidRift session renders
 * in Langfuse as one nested trace: model calls become generations carrying model
 * name, input/output, token usage and derived cost (§10.7); every other source
 * becomes a plain observation; `parentSpanId` reproduces the execution tree.
 *
 * The core holds NO Langfuse dependency — the neutral record is the entire
 * contract (§10.8). The plugin owns the whole Langfuse-facing concern and reaches
 * the SDK only through the scoped CoreAPI (`core.register.exporter`); it never
 * touches SDK internals (§12.4). The record is already secret-masked by the core
 * (§10.10) — the exporter adds NO masking and forwards values as received.
 *
 * ── Client binding (blueprint §4, §7) ───────────────────────────────────────
 * The mapping targets a thin, injectable `LangfuseClient` port — trace /
 * observation / generation / flush. A host binds it to the real `@langfuse/langchain`
 * v5 client (license-verified MIT, pinned); a test injects a mock. This keeps the
 * mapping pure and fully testable offline, and keeps the one Langfuse dependency
 * at the edge, exactly as the §9.5-seam pattern in `@voidrift/plugin-plan`.
 */

import type { ScopedCoreApi, ObsRecord, TokenUsage } from "@voidrift/core";
import { createHttpClient } from "./http-client.js";

// ── §5 configuration ─────────────────────────────────────────────────────────

/**
 * Exporter configuration (blueprint §5). Credentials NEVER live in config: the
 * host supplies the NAMES of the environment variables that hold the Langfuse
 * keys (`publicKeyEnv`/`secretKeyEnv`), which the plugin resolves from
 * `process.env` at use time (FX-C2, langfuse-exporter-blueprint §5). A literal
 * `publicKey`/`secretKey` in config is REJECTED. The resolved secret values live
 * only in this process memory (this interface) and are never persisted or logged.
 */
export interface LangfuseExporterConfig {
  /** Langfuse public key — RESOLVED from the env var the host named. Never a config literal. */
  publicKey: string;
  /** Langfuse secret key — RESOLVED from the env var the host named; never persisted or logged. */
  secretKey: string;
  /** Langfuse endpoint; defaults to Langfuse Cloud. Set for self-hosted. */
  host?: string;
  /** Fraction of TRACES exported, `0.0`–`1.0`. Per `traceId`: a trace is whole or nothing. */
  sampling?: number;
  /** Optional Langfuse release tag applied to every trace. */
  release?: string;
  /** Optional Langfuse environment tag applied to every trace. */
  environment?: string;
}

/**
 * The config shape a HOST / loader supplies (FX-C2). Secrets are referenced by
 * the NAME of the environment variable that holds them — never the literal key.
 * A literal `publicKey`/`secretKey` is a configuration error (the owner's rule:
 * secrets belong in environment variables; langfuse-exporter-blueprint §5).
 */
export interface LangfuseExporterOptionsConfig {
  /** Name of the env var holding the public key (default `LANGFUSE_PUBLIC_KEY`). */
  publicKeyEnv?: string;
  /** Name of the env var holding the secret key (default `LANGFUSE_SECRET_KEY`). */
  secretKeyEnv?: string;
  host?: string;
  sampling?: number;
  release?: string;
  environment?: string;
  // Guard fields: a host that still passes a literal secret is rejected, not
  // silently ignored, so a mistake is visible rather than shipping a leak.
  publicKey?: never;
  secretKey?: never;
}

/** The default env var names when the host names none (FX-C2). */
export const DEFAULT_PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY";
export const DEFAULT_SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY";

// ── §4 the injected Langfuse client port ─────────────────────────────────────

/** A trace shell addressed by the session id (blueprint §2, §3). */
export interface TracePayload {
  id: string;
  name?: string;
  release?: string;
  environment?: string;
}

/** A model GENERATION — the only shape that carries usage and cost (blueprint §2). */
export interface GenerationPayload {
  id: string;
  traceId: string;
  parentObservationId?: string;
  name: string;
  startTime: string;
  endTime?: string;
  level: "DEFAULT" | "ERROR";
  statusMessage?: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  metadata: Record<string, unknown>;
  usageDetails?: {
    input: number;
    output: number;
    total: number;
    cacheRead?: number;
  };
  costDetails?: { total: number };
}

/** A plain OBSERVATION (span event) — every non-model source (blueprint §2). */
export interface ObservationPayload {
  id: string;
  traceId: string;
  parentObservationId?: string;
  name: string;
  startTime: string;
  endTime?: string;
  level: "DEFAULT" | "ERROR";
  statusMessage?: string;
  input?: unknown;
  output?: unknown;
  metadata: Record<string, unknown>;
}

/**
 * The thin Langfuse-facing port the mapping drives (blueprint §4). The default
 * binder maps it onto `@langfuse/langchain` v5; a test injects a mock. The port
 * is addressed by id so the client coalesces records of one `traceId` into one
 * trace and resolves `parentObservationId` by id — out-of-order arrival nests
 * correctly once both exist (blueprint §3).
 */
export interface LangfuseClient {
  trace(payload: TracePayload): void;
  generation(payload: GenerationPayload): void;
  observation(payload: ObservationPayload): void;
  /** Drain queued batches so a short-lived run exports fully before exit (§4). */
  flush(): Promise<void>;
  /** Flush then release the client (teardown on disable, §4, §12.4). */
  shutdown(): Promise<void>;
}

// ── §2 the ObsRecord → Langfuse mapping (pure) ───────────────────────────────

/** `durationMs` → `endTime`; an open (pending) span has start only (blueprint §2). */
function endTimeOf(record: ObsRecord): string | undefined {
  if (typeof record.durationMs !== "number") return undefined;
  return new Date(Date.parse(record.timestamp) + record.durationMs).toISOString();
}

/** `status` → Langfuse `level` + `statusMessage` (blueprint §2). */
function levelOf(record: ObsRecord): { level: "DEFAULT" | "ERROR"; statusMessage?: string } {
  if (record.status !== "error") return { level: "DEFAULT" };
  const msg = record.attributes["message"] ?? record.attributes["error"];
  return typeof msg === "string" ? { level: "ERROR", statusMessage: msg } : { level: "ERROR" };
}

/** `usage` (`TokenUsage`) → generation `usageDetails` (blueprint §2, core §10.1). */
function usageOf(usage: TokenUsage | undefined): GenerationPayload["usageDetails"] {
  if (!usage) return undefined;
  const details: NonNullable<GenerationPayload["usageDetails"]> = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
  };
  if (typeof usage.cacheReadTokens === "number") details.cacheRead = usage.cacheReadTokens;
  return details;
}

/**
 * Derived cost → generation `costDetails` (blueprint §2, core §10.7). The core
 * attaches a monetary cost to `attributes.cost` only when a price is configured;
 * otherwise usage stands alone and Langfuse applies its own model pricing.
 */
function costOf(record: ObsRecord): GenerationPayload["costDetails"] {
  const cost = record.attributes["cost"];
  return typeof cost === "number" ? { total: cost } : undefined;
}

/** A model record (`source: "model"`) → a GENERATION (blueprint §2). */
export function toGeneration(record: ObsRecord): GenerationPayload {
  const { level, statusMessage } = levelOf(record);
  const end = endTimeOf(record);
  const usageDetails = usageOf(record.usage);
  const costDetails = costOf(record);
  return {
    id: record.spanId,
    traceId: record.traceId,
    ...(record.parentSpanId !== undefined ? { parentObservationId: record.parentSpanId } : {}),
    name: record.name,
    startTime: record.timestamp,
    ...(end !== undefined ? { endTime: end } : {}),
    level,
    ...(statusMessage !== undefined ? { statusMessage } : {}),
    ...(record.model ? { model: record.model.name } : {}),
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(record.output !== undefined ? { output: record.output } : {}),
    metadata: {
      ...record.attributes,
      ...(record.model ? { protocol: record.model.protocol } : {}),
    },
    ...(usageDetails !== undefined ? { usageDetails } : {}),
    ...(costDetails !== undefined ? { costDetails } : {}),
  };
}

/** Every non-model record → a plain OBSERVATION with no usage/cost (blueprint §2). */
export function toObservation(record: ObsRecord): ObservationPayload {
  const { level, statusMessage } = levelOf(record);
  const end = endTimeOf(record);
  return {
    id: record.spanId,
    traceId: record.traceId,
    ...(record.parentSpanId !== undefined ? { parentObservationId: record.parentSpanId } : {}),
    name: record.name,
    startTime: record.timestamp,
    ...(end !== undefined ? { endTime: end } : {}),
    level,
    ...(statusMessage !== undefined ? { statusMessage } : {}),
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(record.output !== undefined ? { output: record.output } : {}),
    metadata: { ...record.attributes },
  };
}

/** True when a `source: "model"` record maps to a generation (blueprint §2). */
export function isGeneration(record: ObsRecord): boolean {
  return record.source === "model";
}

// ── §3 per-trace sampling (whole or nothing) ─────────────────────────────────

/**
 * Decides, once per `traceId`, whether this sink forwards the trace (blueprint §5).
 * A sampled-in session exports every span; a sampled-out session exports nothing —
 * a trace is never half-exported. Deterministic per `traceId` so every record of
 * one session agrees. Sampling is this sink's concern and never touches the local
 * trail, which records every span unsampled at all times (core §10.2).
 */
export class TraceSampler {
  private readonly decided = new Map<string, boolean>();
  constructor(private readonly rate: number) {}

  admit(traceId: string): boolean {
    const prior = this.decided.get(traceId);
    if (prior !== undefined) return prior;
    const r = this.rate >= 1 ? true : this.rate <= 0 ? false : hashUnit(traceId) < this.rate;
    this.decided.set(traceId, r);
    return r;
  }
}

/** Stable [0,1) hash of a trace id for deterministic per-trace sampling. */
function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// ── the exporter (blueprint §4, §6) ──────────────────────────────────────────

/** How the exporter reports an isolated failure as a warning (blueprint §6). */
export type WarnFn = (message: string) => void;

/** The `ObsExporter` the plugin registers — record in, Langfuse trace out (§10.8). */
export interface LangfuseObsExporter {
  export(record: ObsRecord): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Build the exporter over a resolved client, config and warn sink. `export` maps
 * the record and hands it to the client, which batches and ships on its own
 * schedule, so `export` returns promptly and never blocks the turn (blueprint §4).
 * A throw in `export` or `flush` is swallowed and surfaced as a warning — it never
 * rejects back into the core write path and never stalls the session (§6).
 */
export function createExporter(
  client: LangfuseClient,
  config: LangfuseExporterConfig,
  warn: WarnFn,
): LangfuseObsExporter {
  const sampler = new TraceSampler(config.sampling ?? 1.0);
  const opened = new Set<string>();

  const openTrace = (record: ObsRecord): void => {
    if (opened.has(record.traceId)) return;
    opened.add(record.traceId);
    client.trace({
      id: record.traceId,
      ...(config.release !== undefined ? { release: config.release } : {}),
      ...(config.environment !== undefined ? { environment: config.environment } : {}),
    });
  };

  return {
    export(record: ObsRecord): void {
      try {
        if (!sampler.admit(record.traceId)) return;
        openTrace(record);
        if (isGeneration(record)) client.generation(toGeneration(record));
        else client.observation(toObservation(record));
      } catch (err) {
        warn(`langfuse-exporter: export failed (isolated): ${errText(err)}`);
      }
    },
    async flush(): Promise<void> {
      try {
        await client.flush();
      } catch (err) {
        warn(`langfuse-exporter: flush failed (isolated): ${errText(err)}`);
      }
    },
    async shutdown(): Promise<void> {
      try {
        await client.shutdown();
      } catch (err) {
        warn(`langfuse-exporter: shutdown failed (isolated): ${errText(err)}`);
      }
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── §5 config validation ─────────────────────────────────────────────────────

/** The metadata host of `host`, or null when `host` is absent, unparsable, or
 * not a metadata address. Returns the bare hostname only (never the URL path or
 * userinfo) so the refusal warning can name it without leaking anything. */
export function metadataHostOf(
  host: string | undefined,
  isMetadataHost: (host: string) => boolean,
): string | null {
  if (host === undefined) return null;
  let h: string;
  try {
    h = new URL(host).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
  return isMetadataHost(h) ? h : null;
}

/**
 * Validate a Langfuse `host` endpoint before any trace leaves the process
 * (audit C4). Traces carry pre-masked model input/output, so a non-loopback
 * host must be `https:`; plaintext `http:` is allowed only on loopback.
 * Credentials embedded in the URL (`user:pass@host`) are rejected — the
 * Langfuse keys travel in `publicKey`/`secretKey`, never the URL. A cloud
 * instance-metadata endpoint (169.254.169.254, metadata.google.internal, …) is
 * REFUSED even over https: masked telemetry must never be posted to a metadata
 * address. The caller passes `isMetadataHost` (the core's never-list predicate
 * via `core.network`) so the list stays single-sourced in the core. Returns a
 * reason naming the `host` key (NEVER echoing the URL or its userinfo) when
 * invalid, or null when the host is acceptable or absent.
 */
export function hostError(
  host: string | undefined,
  isMetadataHost: (host: string) => boolean = () => false,
): string | null {
  if (host === undefined) return null;
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return "host is not a valid URL";
  }
  if (url.username !== "" || url.password !== "") {
    return "host must not contain credentials in the URL; use publicKey/secretKey";
  }
  const h = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isMetadataHost(h)) {
    return "host is a cloud instance-metadata address; refusing to send telemetry there";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    const loopback = h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
    return loopback ? null : "host must use https for a non-loopback endpoint (plaintext http is allowed only on loopback)";
  }
  return "host must use http (loopback only) or https";
}

/**
 * Validate resolved config (blueprint §5). Missing credentials are a config
 * error the plugin reports once and then no-ops — a misconfigured exporter
 * degrades to silence, never to a broken session. This operates on ALREADY
 * RESOLVED credentials (the env values); `register` resolves env names first via
 * `resolveOptionsConfig` (FX-C2).
 */
export function validateConfig(
  config: Partial<LangfuseExporterConfig> | undefined,
  isMetadataHost: (host: string) => boolean = () => false,
): LangfuseExporterConfig | null {
  if (!config || !config.publicKey || !config.secretKey) return null;
  const sampling = config.sampling;
  if (sampling !== undefined && (sampling < 0 || sampling > 1 || Number.isNaN(sampling))) return null;
  if (hostError(config.host, isMetadataHost) !== null) return null;
  return {
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.sampling !== undefined ? { sampling: config.sampling } : {}),
    ...(config.release !== undefined ? { release: config.release } : {}),
    ...(config.environment !== undefined ? { environment: config.environment } : {}),
  };
}

/** The result of resolving a host-supplied options config into runtime config
 * (FX-C2): either a resolved `config`, or a `reason` the exporter is disabled. */
export interface ResolveResult {
  config: LangfuseExporterConfig | null;
  reason: string | null;
}

/**
 * Resolve the host-supplied options config (env NAMES) into runtime config with
 * the secret VALUES read from `env` at use time (FX-C2, langfuse-exporter-blueprint
 * §5). Rules:
 *  - A literal `publicKey`/`secretKey` in config is REJECTED with a clear reason
 *    (secrets belong in environment variables).
 *  - The env var NAMES default to `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`.
 *  - A named env var that is absent/empty disables the exporter with a reason —
 *    it never throws.
 *  - `host`/`sampling`/`release`/`environment` pass through and are validated.
 */
export function resolveOptionsConfig(
  optionsConfig: LangfuseExporterOptionsConfig | undefined,
  env: Record<string, string | undefined> = process.env,
  isMetadataHost: (host: string) => boolean = () => false,
): ResolveResult {
  const anyCfg = (optionsConfig ?? {}) as Record<string, unknown>;
  if (anyCfg["publicKey"] !== undefined || anyCfg["secretKey"] !== undefined) {
    return {
      config: null,
      reason: "secrets belong in environment variables; set publicKeyEnv/secretKeyEnv",
    };
  }
  const publicKeyEnv = optionsConfig?.publicKeyEnv ?? DEFAULT_PUBLIC_KEY_ENV;
  const secretKeyEnv = optionsConfig?.secretKeyEnv ?? DEFAULT_SECRET_KEY_ENV;
  const publicKey = env[publicKeyEnv];
  const secretKey = env[secretKeyEnv];
  if (!publicKey || !secretKey) {
    const missing = !publicKey ? publicKeyEnv : secretKeyEnv;
    return { config: null, reason: `environment variable ${missing} is not set; exporter disabled` };
  }
  const resolved = validateConfig(
    {
      publicKey,
      secretKey,
      ...(optionsConfig?.host !== undefined ? { host: optionsConfig.host } : {}),
      ...(optionsConfig?.sampling !== undefined ? { sampling: optionsConfig.sampling } : {}),
      ...(optionsConfig?.release !== undefined ? { release: optionsConfig.release } : {}),
      ...(optionsConfig?.environment !== undefined ? { environment: optionsConfig.environment } : {}),
    },
    isMetadataHost,
  );
  if (!resolved) {
    const he = hostError(optionsConfig?.host, isMetadataHost);
    return { config: null, reason: he ?? "invalid Langfuse config" };
  }
  return { config: resolved, reason: null };
}

// ── register (blueprint §1, §4, §12.4) ───────────────────────────────────────

/**
 * Options the host supplies at `register` (blueprint §4, §5; FX-C2). `config`
 * references the credentials by the NAMES of their env vars (`publicKeyEnv`/
 * `secretKeyEnv`), never literal secrets; `clientFactory` binds the Langfuse
 * client (default: the dependency-light HTTPS ingestion client); `warn` sinks
 * isolated failures (the core's `ERROR_OCCURRED` warning path, §6). `env` is a
 * test seam for the environment lookup.
 */
export interface LangfuseExporterOptions {
  config?: LangfuseExporterOptionsConfig;
  clientFactory?: (config: LangfuseExporterConfig) => LangfuseClient;
  warn?: WarnFn;
  /** Environment lookup; defaults to `process.env` (FX-C2 test seam). */
  env?: Record<string, string | undefined>;
}

/**
 * The plugin's `register`. Resolves config, builds the client (real or injected),
 * and registers one `ObsExporter` on the scoped CoreAPI (§10.8, §12.4). On missing
 * or invalid credentials it reports once and registers nothing — the exporter
 * no-ops rather than throwing (§5). Returns a teardown that flushes then shuts the
 * client down so a hot-disable loses no buffered events (§4). A throw anywhere is
 * caught and warned; it never crashes the core (§6, §12.4).
 */
export function register(core: ScopedCoreApi, options: LangfuseExporterOptions = {}): (() => Promise<void>) | undefined {
  const warn: WarnFn = options.warn ?? ((m) => console.warn(m));
  const isMetadataHost = (host: string): boolean => {
    try {
      return core.network?.isMetadataHost(host) ?? false;
    } catch {
      return false;
    }
  };
  const { config, reason } = resolveOptionsConfig(options.config, options.env ?? process.env, isMetadataHost);
  if (!config) {
    const metaHost = metadataHostOf(options.config?.host, isMetadataHost);
    if (metaHost) {
      warn(`langfuse-exporter: endpoint ${metaHost} is a cloud instance-metadata address; refusing to send telemetry there; exporter disabled`);
      return undefined;
    }
    warn(`langfuse-exporter: ${reason ?? "missing or invalid Langfuse config"}; exporter disabled`);
    return undefined;
  }

  let client: LangfuseClient;
  try {
    const factory = options.clientFactory ?? ((c: LangfuseExporterConfig) => defaultClientFactory(c, warn));
    client = factory(config);
  } catch (err) {
    warn(`langfuse-exporter: client init failed; exporter disabled: ${errText(err)}`);
    return undefined;
  }

  const exporter = createExporter(client, config, warn);
  core.register.exporter({
    export: (record: ObsRecord) => exporter.export(record),
    flush: () => exporter.flush(),
  });

  return async () => {
    await exporter.flush();
    await exporter.shutdown();
  };
}

/**
 * The default client binding (blueprint §4, §7). A dependency-light HTTPS sink
 * onto Langfuse's public ingestion API (`POST {host}/api/public/ingestion`) via
 * the platform `fetch` and HTTP Basic auth — no new runtime dependency, nothing
 * persisted, nothing logged that carries a secret. It batches and ships
 * asynchronously (§4): `export` only enqueues, a bounded queue drops the oldest
 * under back-pressure, a timer and `flush`/`shutdown` drain it, each request
 * carries a 10 s timeout and never follows a redirect, and every network failure
 * is isolated to the `warn` sink and never reaches the turn (§4, §6).
 */
function defaultClientFactory(config: LangfuseExporterConfig, warn: WarnFn): LangfuseClient {
  return createHttpClient(config, { warn });
}
