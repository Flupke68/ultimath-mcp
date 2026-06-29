#!/usr/bin/env node

// =========================================================================
// ultimath-mcp — MCP server for Ultimath multi-engine math evaluation
//
// Tools:
//   evaluate       — evaluate an expression on 4 engines
//   list_functions — discover available functions and categories
//
// 2026-05-25: initial implementation.
// 2026-05-29: aligned with v2 schema.
// 2026-05-30: simplified to match minimal REST response.
// 2026-05-30: added list_functions tool.
// 2026-05-30: description honesty — drop unshipped zeta/gamma/erf claims,
//             point to list_functions as the authoritative catalog.
// =========================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// =========================================================================
// Configuration
// =========================================================================

// Prefer the ULTIMATH_* names (current brand); fall back to the legacy UTEVIA_*
// so existing MCP configs keep working without an edit to ~/.claude.json.
const API_URL =
  process.env.ULTIMATH_API_URL ?? process.env.UTEVIA_API_URL ?? "https://ultimath.ai";
const API_KEY = process.env.ULTIMATH_API_KEY ?? process.env.UTEVIA_API_KEY;
const FETCH_TIMEOUT_MS = 10_000;

if (!API_KEY) {
  console.error(
    "ERROR: ULTIMATH_API_KEY environment variable is required.\n" +
    "Get your key at https://ultimath.ai and set it in your MCP config."
  );
  process.exit(1);
}

// =========================================================================
// Types for the REST API response
// =========================================================================

// Structured form of one runtime reliability warning (mirrors the REST API's
// `diagnostics`): a machine-readable code + metrics, so an AI client reads the
// code directly instead of re-parsing the human-readable `warnings` string.
interface Diagnostic {
  code: string;       // EvalWarningId name, e.g. "SeriesNotConverged"
  emitter: string;    // operator symbol or function name, e.g. "==", "erf"
  args: string[];     // positional metric values (ULP, term cap, digits, ...)
  message: string;    // rendered human-readable message
}

interface EngineEntry {
  result: string;
  error?: string;
  // Compile-stage warnings emitted by the REST API (ApiV1Controller).
  compile_warnings?: string[];
  // Structured runtime reliability signals (machine-readable code + metrics +
  // message). The runtime `warnings[]` string array was merged into this — its
  // human-readable text now lives in each diagnostic's `message`.
  diagnostics?: Diagnostic[];
}

interface EvalResponse {
  expression: string;
  angle_unit?: string;
  engines: Record<string, EngineEntry>;
  meta: { id: string; ms: number };
}

interface ErrorResponse {
  error: string;
  max_precision?: number;
  requested?: number;
}

// Function catalog entry (from GET /api/v1/functions)
interface FunctionEntry {
  name: string;
  arity: number;
  category: string;
  description: string;
  help_text?: string;
  param_names?: string;
}

// =========================================================================
// REST API caller
// =========================================================================

async function callEvaluateApi(
  expression: string,
  precision?: number,
  format?: string
): Promise<{ status: number; body: EvalResponse | ErrorResponse }> {
  const payload: Record<string, unknown> = { expression };
  if (precision !== undefined) payload.precision = precision;
  if (format !== undefined) payload.format = format;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_URL}/api/v1/evaluate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY!,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = (await res.json()) as EvalResponse | ErrorResponse;
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

// =========================================================================
// Format successful response
// =========================================================================

const ENGINE_ORDER = ["flint", "dec", "cpp", "mpfi"] as const;

const ENGINE_LABELS: Record<string, string> = {
  flint: "flint    (multiprecision)",
  dec:   "dec      (decimal)       ",
  cpp:   "cpp      (IEEE 754)      ",
  mpfi:  "mpfi     (enclosure)     ",
};

// Compile-time warnings first (e.g. literal rounded at parse), then the runtime
// reliability signals (now carried only in `diagnostics`, read from `.message`).
function engineWarnings(eng: EngineEntry): string[] {
  return [...(eng.compile_warnings ?? []), ...((eng.diagnostics ?? []).map((d) => d.message))];
}

function formatSuccess(data: EvalResponse): string {
  const { expression, engines = {}, meta, angle_unit } = data;
  const lines: string[] = [];

  // Header
  lines.push(`Expression: ${expression}`);
  if (angle_unit && angle_unit !== "rad") {
    lines.push(`Angle: ${angle_unit}`);
  }
  lines.push("");

  // Per-engine results
  for (const key of ENGINE_ORDER) {
    const eng = engines[key];
    if (!eng) continue;
    const label = ENGINE_LABELS[key] ?? key;
    if (eng.error) {
      lines.push(`  ${label}  ✗ ${eng.error}`);
    } else {
      lines.push(`  ${label}  ${eng.result}`);
    }
    for (const w of engineWarnings(eng)) {
      lines.push(`  ${" ".repeat(label.length)}  ⚠ ${w}`);
    }
  }

  // Any extra engines not in the standard order
  for (const key of Object.keys(engines)) {
    if (ENGINE_ORDER.includes(key as any)) continue;
    const eng = engines[key];
    const label = (key + " ".repeat(25)).slice(0, 25);
    lines.push(`  ${label}  ${eng.error ?? eng.result}`);
    for (const w of engineWarnings(eng)) {
      lines.push(`  ${" ".repeat(label.length)}  ⚠ ${w}`);
    }
  }

  // Meta
  if (meta) {
    lines.push("");
    lines.push(`Trace: ${meta.id}  Time: ${meta.ms}ms`);
  }

  return lines.join("\n");
}

// =========================================================================
// Structured output (MCP structuredContent)
//
// Mirrors the rendered text table as machine-readable fields so a client can
// extract per-engine results and warnings without re-parsing the text. The
// text content above is kept unchanged for clients that only read text.
// =========================================================================

interface StructuredEngine {
  name: string;
  result?: string;
  error?: string;
  warnings: string[]; // compile-time then runtime, same order as the text
  diagnostics: Diagnostic[]; // structured runtime warnings (machine-readable)
}

function buildStructured(data: EvalResponse): {
  expression: string;
  angle_unit?: string;
  engines: StructuredEngine[];
  inexact: boolean;
  trace?: string;
  ms?: number;
} {
  const { expression, engines = {}, meta, angle_unit } = data;

  const out: StructuredEngine[] = [];
  const seen = new Set<string>();
  const pushEngine = (key: string, eng: EngineEntry) => {
    seen.add(key);
    const entry: StructuredEngine = {
      name: key,
      warnings: engineWarnings(eng),
      diagnostics: eng.diagnostics ?? [],
    };
    if (eng.result !== undefined) entry.result = eng.result;
    if (eng.error !== undefined) entry.error = eng.error;
    out.push(entry);
  };

  // Standard engines first, in display order, then any extras.
  for (const key of ENGINE_ORDER) {
    if (engines[key]) pushEngine(key, engines[key]);
  }
  for (const key of Object.keys(engines)) {
    if (!seen.has(key)) pushEngine(key, engines[key]);
  }

  return {
    expression,
    ...(angle_unit ? { angle_unit } : {}),
    engines: out,
    // Convenience flag: did any engine flag a loss of precision / domain issue?
    inexact: out.some((e) => e.warnings.length > 0),
    ...(meta?.id ? { trace: meta.id } : {}),
    ...(meta?.ms !== undefined ? { ms: meta.ms } : {}),
  };
}

// =========================================================================
// Format error response
// =========================================================================

function formatError(status: number, body: ErrorResponse): string {
  let msg = `Error ${status}: ${body.error}`;
  if (body.max_precision !== undefined) {
    msg += ` (max: ${body.max_precision}, requested: ${body.requested})`;
  }
  return msg;
}

// =========================================================================
// Functions catalog API caller
// =========================================================================

async function callFunctionsApi(): Promise<{ status: number; body: FunctionEntry[] | ErrorResponse }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_URL}/api/v1/functions`, {
      method: "GET",
      headers: {
        "X-API-Key": API_KEY!,
      },
      signal: controller.signal,
    });

    const body = (await res.json()) as FunctionEntry[] | ErrorResponse;
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

// =========================================================================
// Format function catalog
// =========================================================================

function formatFunctions(functions: FunctionEntry[], category?: string): string {
  let filtered = functions;
  if (category) {
    const cat = category.toLowerCase();
    filtered = functions.filter((f) => f.category.toLowerCase() === cat);
    if (filtered.length === 0) {
      const cats = [...new Set(functions.map((f) => f.category))].sort();
      return `No functions in category "${category}". Available categories: ${cats.join(", ")}`;
    }
  }

  // Group by category
  const groups = new Map<string, FunctionEntry[]>();
  for (const f of filtered) {
    const list = groups.get(f.category) ?? [];
    list.push(f);
    groups.set(f.category, list);
  }

  const lines: string[] = [];
  lines.push(`${filtered.length} functions available:\n`);

  for (const [cat, fns] of [...groups.entries()].sort()) {
    lines.push(`${cat}:`);
    for (const f of fns.sort((a, b) => a.name.localeCompare(b.name))) {
      const params = f.param_names ?? "x".repeat(f.arity).split("").join(", ");
      lines.push(`  ${f.name}(${params}) — ${f.description}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// =========================================================================
// MCP Server setup
// =========================================================================

const server = new McpServer({
  name: "ultimath",
  version: "0.1.4",
});

server.registerTool(
  "evaluate",
  {
    title: "Evaluate & cross-check a math expression",
    annotations: { title: "Evaluate & cross-check a math expression", readOnlyHint: true },
    description:
      "Verify any numeric result that has to be trusted, via the Ultimath API (https://ultimath.ai). " +
      "Use this whenever the correctness of a number matters — floating-point-sensitive expressions, " +
      "catastrophic cancellation, values near singularities or branch cuts, ties, or any computation where a " +
      "single method could be silently wrong. Prefer it over computing by hand or running code: it evaluates " +
      "the expression on 4 independent engines (multiprecision, decimal, IEEE 754 double, interval arithmetic) " +
      "in parallel and returns every result plus per-engine precision diagnostics, so disagreement exposes an " +
      "unreliable value that a single calculation would hide.\n\n" +
      "The 4 engines are independent and each computes with its own native primitive — so " +
      "divergence between them (at poles, singularities, branch cuts, or ties like round(2.5)) " +
      "is the backends' real behavior, NOT a bug. Agreement across engines is a confidence " +
      "signal; divergence flags a value that is convention-dependent or near a domain edge — " +
      "verify it rather than trust a single column.\n\n" +
      "Supports: arithmetic, trigonometry (sin, cos, tan), exponentials and logs " +
      "(exp, ln, log), roots and powers (sqrt, x^y), factorial, complex numbers (3+2i), " +
      "arbitrary bases (0xFF, 0b1010), constants (pi, e, the golden ratio PHI). " +
      "Multiplication must be EXPLICIT: write 2*pi, 2*(3+4), (a+b)*(c+d), 2*sin(x) — " +
      "adjacency is NOT a product (2pi is an error). Precedence, tightest first: postfix " +
      "factorial ! (2^3! = 2^(3!) = 64), then powers ^, then * / %, then + -. " +
      "Note: expressions are mathematical only — " +
      "there are no type casts ((int)x) or constructors (complex(1,2)); write a complex " +
      "number as 1+2i or (re, im). " +
      "Call list_functions for the authoritative list of available functions.",
    inputSchema: {
      expression: z
        .string()
        .describe("Math expression, e.g. '0.1 + 0.2', 'sin(pi/4)', 'sqrt(2)^2 - 2', '2*pi', '2*(3+4)', 'factorial(10)'"),
      precision: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Decimal digits of precision (default 50). The free beta caps at 50; higher values are rejected server-side."),
      format: z
        .enum(["fixed", "scientific", "auto"])
        .optional()
        .describe("Output format (default 'fixed')"),
    },
    outputSchema: {
      expression: z.string(),
      angle_unit: z.string().optional(),
      engines: z
        .array(
          z.object({
            name: z.string().describe("Engine id: flint, dec, cpp, or mpfi"),
            result: z.string().optional().describe("Result, present unless the engine errored"),
            error: z.string().optional().describe("Error message, present instead of result on failure"),
            warnings: z
              .array(z.string())
              .describe("Diagnostics: rounded literal, inexact value, overflow, etc."),
            diagnostics: z
              .array(
                z.object({
                  code: z.string().describe("Machine-readable warning code, e.g. SeriesNotConverged"),
                  emitter: z.string().describe("Operator symbol or function that raised it"),
                  args: z.array(z.string()).describe("Positional metric values (ULP, term cap, digits lost, ...)"),
                  message: z.string().describe("Human-readable rendering"),
                })
              )
              .describe("Structured runtime warnings — machine-readable form of `warnings`"),
          })
        )
        .describe("Per-engine results, compare to detect floating-point error"),
      inexact: z
        .boolean()
        .describe("True if any engine emitted a warning (precision loss or domain issue somewhere)"),
      trace: z.string().optional(),
      ms: z.number().optional(),
    },
  },
  async ({ expression, precision, format }) => {
    try {
      const { status, body } = await callEvaluateApi(expression, precision, format);

      if (status === 200) {
        return {
          content: [
            { type: "text", text: formatSuccess(body as EvalResponse) },
          ],
          structuredContent: buildStructured(body as EvalResponse),
        };
      }

      return {
        content: [
          { type: "text", text: formatError(status, body as ErrorResponse) },
        ],
        isError: true,
      };
    } catch (err: unknown) {
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;

      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "list_functions",
  {
    title: "List available functions",
    annotations: { title: "List available functions", readOnlyHint: true },
    description:
      "List all mathematical functions available via the Ultimath API (https://ultimath.ai). " +
      "Returns name, arity, category, and description for each function. " +
      "Use this to discover what functions you can pass to the evaluate tool. " +
      "Optionally filter by category (algebraic, trigonometric, hyperbolic, " +
      "exponential, special, rounding, introspection). " +
      "Every function is available on all 4 engines, but each computes it with its own " +
      "native primitive — so results may diverge at poles, branch cuts, or ties, and that " +
      "divergence is honest backend behavior, not a bug.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe("Filter by category, e.g. 'special', 'trigonometric'. Omit to list all."),
    },
  },
  async ({ category }) => {
    try {
      const { status, body } = await callFunctionsApi();

      if (status === 200) {
        return {
          content: [
            { type: "text", text: formatFunctions(body as FunctionEntry[], category) },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: formatError(status, body as ErrorResponse) },
        ],
        isError: true,
      };
    } catch (err: unknown) {
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;

      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

// =========================================================================
// Start
// =========================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
