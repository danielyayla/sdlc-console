import { randomBytes } from "node:crypto";

/**
 * OpenTelemetry traces without the OpenTelemetry SDK (3.3): spans for
 * sessions, jobs and runs are batched and exported as OTLP/HTTP JSON
 * (`ExportTraceServiceRequest` to `POST <endpoint>/v1/traces`) through the
 * global `fetch` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it every
 * span is a no-op with no ids. Export failures never reach the lifecycle:
 * the batch is dropped, the failure is logged once, and the console keeps
 * going. Traces are an external system of record; the console keeps only
 * the trace id so a view can link out.
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue | null | undefined>;

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface SpanStatus {
  ok: boolean;
  message?: string;
}

export interface Span {
  readonly name: string;
  /** Null on the no-op tracer: nothing is exported, so nothing can be linked. */
  readonly traceId: string | null;
  readonly spanId: string | null;
  context(): SpanContext | null;
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes, timeMs?: number): void;
  end(status?: SpanStatus, timeMs?: number): void;
}

export interface SpanOptions {
  attributes?: Attributes;
  /** Parent span (or a stored context): the child joins its trace. */
  parent?: SpanContext | Span | null;
  startTimeMs?: number;
}

export interface Tracer {
  readonly enabled: boolean;
  startSpan(name: string, options?: SpanOptions): Span;
  /** Export what has finished so far. */
  flush(): Promise<void>;
  /** Stop the interval and flush; the tracer stays usable but exports only on flush. */
  shutdown(): Promise<void>;
}

class NoopSpan implements Span {
  readonly traceId = null;
  readonly spanId = null;
  constructor(readonly name: string) {}
  context(): null {
    return null;
  }
  setAttributes(): void {
    /* nothing to record */
  }
  addEvent(): void {
    /* nothing to record */
  }
  end(): void {
    /* nothing to export */
  }
}

/** The tracer without an exporter: spans carry no ids and nothing leaves the process. */
export const noopTracer: Tracer = {
  enabled: false,
  startSpan: (name) => new NoopSpan(name),
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Attributes;
  events: { name: string; timeMs: number; attributes: Attributes }[];
  status: SpanStatus | null;
}

export interface OtlpTracerOptions {
  /** Full traces URL (`…/v1/traces`). */
  url: string;
  headers?: Record<string, string>;
  serviceName?: string;
  fetch?: typeof fetch;
  /** Flush interval in ms (default 5000). */
  intervalMs?: number;
  /** Finished spans kept while waiting for a flush (default 2000); older ones are dropped. */
  maxQueue?: number;
  now?: () => number;
  log?: (line: string) => void;
}

function contextOf(parent: SpanOptions["parent"]): SpanContext | null {
  if (!parent) return null;
  if ("context" in parent && typeof parent.context === "function") return parent.context();
  const p = parent as SpanContext;
  return p.traceId && p.spanId ? { traceId: p.traceId, spanId: p.spanId } : null;
}

class LiveSpan implements Span {
  readonly traceId: string;
  readonly spanId: string;
  private readonly parentSpanId: string | null;
  private readonly attributes: Attributes;
  private readonly events: FinishedSpan["events"] = [];
  private ended = false;

  constructor(
    readonly name: string,
    options: SpanOptions,
    private readonly startMs: number,
    private readonly now: () => number,
    private readonly finish: (span: FinishedSpan) => void,
  ) {
    const parent = contextOf(options.parent);
    this.traceId = parent?.traceId ?? randomBytes(16).toString("hex");
    this.spanId = randomBytes(8).toString("hex");
    this.parentSpanId = parent?.spanId ?? null;
    this.attributes = { ...(options.attributes ?? {}) };
  }

  context(): SpanContext {
    return { traceId: this.traceId, spanId: this.spanId };
  }

  setAttributes(attributes: Attributes): void {
    Object.assign(this.attributes, attributes);
  }

  addEvent(name: string, attributes: Attributes = {}, timeMs = this.now()): void {
    this.events.push({ name, timeMs, attributes });
  }

  end(status: SpanStatus | null = null, timeMs = this.now()): void {
    if (this.ended) return;
    this.ended = true;
    this.finish({ traceId: this.traceId, spanId: this.spanId, parentSpanId: this.parentSpanId, name: this.name, startMs: this.startMs, endMs: Math.max(timeMs, this.startMs), attributes: this.attributes, events: this.events, status });
  }
}

function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function attributeList(attributes: Attributes): { key: string; value: Record<string, unknown> }[] {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, v] of Object.entries(attributes)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
    else if (typeof v === "number") out.push({ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } });
    else out.push({ key, value: { stringValue: v } });
  }
  return out;
}

/** The OTLP/JSON `ExportTraceServiceRequest` for a batch of finished spans. */
export function otlpRequest(serviceName: string, spans: readonly FinishedSpan[]): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: attributeList({ "service.name": serviceName }) },
        scopeSpans: [
          {
            scope: { name: "sdlc-console" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: nanos(s.startMs),
              endTimeUnixNano: nanos(s.endMs),
              attributes: attributeList(s.attributes),
              events: s.events.map((e) => ({ timeUnixNano: nanos(e.timeMs), name: e.name, attributes: attributeList(e.attributes) })),
              status: s.status === null ? { code: 0 } : s.status.ok ? { code: 1 } : { code: 2, ...(s.status.message ? { message: s.status.message } : {}) },
            })),
          },
        ],
      },
    ],
  };
}

export class OtlpTracer implements Tracer {
  readonly enabled = true;
  private queue: FinishedSpan[] = [];
  private timer: NodeJS.Timeout | null;
  private inflight: Promise<void> | null = null;
  private warned = false;
  private readonly send: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: OtlpTracerOptions) {
    this.send = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    const interval = opts.intervalMs ?? 5000;
    this.timer = interval > 0 ? setInterval(() => void this.flush(), interval) : null;
    this.timer?.unref();
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    return new LiveSpan(name, options, options.startTimeMs ?? this.now(), this.now, (s) => this.enqueue(s));
  }

  private enqueue(span: FinishedSpan): void {
    const max = this.opts.maxQueue ?? 2000;
    this.queue.push(span);
    if (this.queue.length > max) this.queue.splice(0, this.queue.length - max);
  }

  /** Spans finished and not yet exported (tests). */
  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.inflight) await this.inflight;
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.inflight = (async () => {
      try {
        const res = await this.send(this.opts.url, { method: "POST", headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) }, body: JSON.stringify(otlpRequest(this.opts.serviceName ?? "sdlc-console", batch)) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.warned = false;
      } catch (e) {
        // the batch is gone; lifecycle behaviour never waits on telemetry
        if (!this.warned) this.opts.log?.(`[otel] trace export to ${this.opts.url} failed: ${(e as Error).message} (${batch.length} span(s) dropped; reported once until it recovers)`);
        this.warned = true;
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/** `OTEL_EXPORTER_OTLP_HEADERS`: `key=value,key2=value2` (values URL-encoded per the OTel spec). */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    if (key) out[key] = value;
  }
  return out;
}

export interface TracerEnvOptions {
  fetch?: typeof fetch;
  intervalMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * The tracer the environment asks for: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 * (used as is) or `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`, with
 * `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME` (default `sdlc-console`);
 * the no-op tracer when neither endpoint is set.
 */
export function tracerFromEnv(env: Record<string, string | undefined>, options: TracerEnvOptions = {}): Tracer {
  const traces = env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]?.trim();
  const base = env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim();
  const url = traces && traces !== "" ? traces : base && base !== "" ? `${base.replace(/\/+$/, "")}/v1/traces` : null;
  if (!url) return noopTracer;
  return new OtlpTracer({ url, headers: parseOtlpHeaders(env["OTEL_EXPORTER_OTLP_HEADERS"]), serviceName: env["OTEL_SERVICE_NAME"]?.trim() || "sdlc-console", ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}), ...(options.log ? { log: options.log } : {}), ...(options.now ? { now: options.now } : {}) });
}

/** `OTEL_TRACE_URL_TEMPLATE` with `{traceId}` substituted (e.g. `https://jaeger.example/trace/{traceId}`); null without a template or an id. */
export function traceUrlFor(template: string | null | undefined, traceId: string | null | undefined): string | null {
  if (!template || !traceId) return null;
  return template.includes("{traceId}") ? template.split("{traceId}").join(traceId) : `${template}${traceId}`;
}
