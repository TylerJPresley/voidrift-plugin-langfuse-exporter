/**
 * The default Langfuse client binding (langfuse-exporter-blueprint §4, §7).
 *
 * The blueprint's §4 transport is a Langfuse client that batches events and
 * ships them asynchronously; the mapping (§2) drives it through the thin
 * `LangfuseClient` port (`trace`/`generation`/`observation`/`flush`/`shutdown`).
 * This module is that port's default binding: a dependency-light HTTPS sink onto
 * Langfuse's public ingestion API (`POST {host}/api/public/ingestion`) using the
 * platform `fetch` and HTTP Basic auth (`base64(publicKey:secretKey)`) — no new
 * runtime dependency, nothing persisted, nothing logged that carries a secret.
 *
 * It obeys the blueprint's isolation and non-blocking rules directly:
 *  - `trace`/`generation`/`observation` only ENQUEUE and never await the network,
 *    so `export` returns promptly and the turn is never blocked (§4).
 *  - A bounded queue drops the OLDEST event when full and counts the drops, so a
 *    stalled or killed receiver can never grow memory without bound (§4, §6).
 *  - A batch flushes on an interval and on `flush()`/`shutdown()`; the request
 *    carries a fixed 10 s timeout and never follows a redirect, so a hostile or
 *    misbehaving endpoint cannot hang the drain or be bounced to another host.
 *  - Every network failure is swallowed and surfaced to the exporter's warn sink
 *    (§6); it never rejects back into the core write path.
 */

import type {
  LangfuseClient,
  LangfuseExporterConfig,
  GenerationPayload,
  ObservationPayload,
  TracePayload,
  WarnFn,
} from "./index.js";

/** Fixed transport constants (internal — promoted to config only on demonstrated need, AGENTS.md). */
const DEFAULT_HOST = "https://cloud.langfuse.com";
const INGESTION_PATH = "/api/public/ingestion";
const REQUEST_TIMEOUT_MS = 10_000;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_QUEUE = 2_000;
const MAX_BATCH = 100;

/** One Langfuse ingestion event (the public batch-ingestion envelope, §4). */
interface IngestionEvent {
  id: string;
  type: "trace-create" | "generation-create" | "span-create";
  timestamp: string;
  body: Record<string, unknown>;
}

let eventSeq = 0;
/** A per-process-unique event id so a retry/duplicate is idempotent at Langfuse. */
function nextEventId(): string {
  eventSeq += 1;
  return `vr-${Date.now().toString(36)}-${eventSeq.toString(36)}`;
}

/** Strip undefined so the JSON body stays compact and predictable. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function traceEvent(p: TracePayload): IngestionEvent {
  return {
    id: nextEventId(),
    type: "trace-create",
    timestamp: new Date().toISOString(),
    body: compact({ id: p.id, name: p.name, release: p.release, environment: p.environment }),
  };
}

function generationEvent(p: GenerationPayload): IngestionEvent {
  return {
    id: nextEventId(),
    type: "generation-create",
    timestamp: p.startTime,
    body: compact({
      id: p.id,
      traceId: p.traceId,
      parentObservationId: p.parentObservationId,
      type: "GENERATION",
      name: p.name,
      startTime: p.startTime,
      endTime: p.endTime,
      level: p.level,
      statusMessage: p.statusMessage,
      model: p.model,
      input: p.input,
      output: p.output,
      metadata: p.metadata,
      usageDetails: p.usageDetails,
      costDetails: p.costDetails,
    }),
  };
}

function observationEvent(p: ObservationPayload): IngestionEvent {
  return {
    id: nextEventId(),
    type: "span-create",
    timestamp: p.startTime,
    body: compact({
      id: p.id,
      traceId: p.traceId,
      parentObservationId: p.parentObservationId,
      type: "SPAN",
      name: p.name,
      startTime: p.startTime,
      endTime: p.endTime,
      level: p.level,
      statusMessage: p.statusMessage,
      input: p.input,
      output: p.output,
      metadata: p.metadata,
    }),
  };
}

/** The ingestion URL from a resolved `host` (defaulting to Langfuse Cloud). */
export function ingestionUrl(host: string | undefined): string {
  const base = (host ?? DEFAULT_HOST).replace(/\/+$/, "");
  return `${base}${INGESTION_PATH}`;
}

/** The HTTP Basic auth header value for the resolved keys (never logged, §5). */
export function basicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`, "utf8").toString("base64")}`;
}

/** Injectable fetch, so the loopback test drives the real queue/flush path offline. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<{ ok: boolean; status: number }>;

export interface HttpClientDeps {
  /** Defaults to the platform `fetch`; injected by the loopback test. */
  fetchImpl?: FetchLike;
  /** Isolated-failure sink (§6); defaults to a silent no-op. */
  warn?: WarnFn;
  /** Overridable only for tests (fast flush, small queue). */
  flushIntervalMs?: number;
  maxQueue?: number;
  maxBatch?: number;
}

/**
 * Build the default HTTPS ingestion client (§4). It enqueues on the mapping
 * calls, flushes a bounded batch on a timer and on demand, and drops the oldest
 * event with a counter when the queue is full — so a dead receiver never blocks
 * a turn nor grows memory. `shutdown` flushes then stops the timer.
 */
export function createHttpClient(config: LangfuseExporterConfig, deps: HttpClientDeps = {}): LangfuseClient {
  const url = ingestionUrl(config.host);
  const auth = basicAuthHeader(config.publicKey, config.secretKey);
  const fetchImpl: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const warn: WarnFn = deps.warn ?? (() => {});
  const flushIntervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxQueue = deps.maxQueue ?? MAX_QUEUE;
  const maxBatch = deps.maxBatch ?? MAX_BATCH;

  const queue: IngestionEvent[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let draining: Promise<void> | undefined;

  const enqueue = (event: IngestionEvent): void => {
    queue.push(event);
    while (queue.length > maxQueue) {
      queue.shift();
      dropped += 1;
    }
    ensureTimer();
  };

  const ensureTimer = (): void => {
    if (timer || flushIntervalMs <= 0) return;
    timer = setInterval(() => void drainOnce(), flushIntervalMs);
    // Do not keep the event loop alive for the flush timer (a short run exits).
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
  };

  const sendBatch = async (batch: IngestionEvent[]): Promise<void> => {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ batch }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) warn(`langfuse-exporter: ingestion returned status ${res.status} (isolated)`);
    } finally {
      clearTimeout(to);
    }
  };

  /** Flush every queued event in bounded batches; isolate any network failure (§6). */
  const drainOnce = async (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      try {
        while (queue.length > 0) {
          const batch = queue.splice(0, maxBatch);
          try {
            await sendBatch(batch);
          } catch (err) {
            // A failed batch is dropped (the local trail holds the record, §6);
            // the exporter favors session availability over Langfuse delivery.
            warn(`langfuse-exporter: ingestion flush failed (isolated): ${errText(err)}`);
          }
        }
        if (dropped > 0) {
          warn(`langfuse-exporter: dropped ${dropped} event(s) under back-pressure (bounded queue)`);
          dropped = 0;
        }
      } finally {
        draining = undefined;
      }
    })();
    return draining;
  };

  return {
    trace: (p) => enqueue(traceEvent(p)),
    generation: (p) => enqueue(generationEvent(p)),
    observation: (p) => enqueue(observationEvent(p)),
    flush: () => drainOnce(),
    async shutdown(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await drainOnce();
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
