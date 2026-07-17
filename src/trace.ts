/**
 * trace.ts — re-export shim. The real trace/time-travel viewer model (buildTrace/traceToJson/
 * Trace/TraceStep) now lives in shared/trace.ts (moved there in a follow-up cleanup so both
 * src/ and bridge/report.ts import it from a neutral location instead of bridge/ reaching into
 * a frontend directory). Kept here, re-exporting verbatim, so every existing src/ import site
 * (TraceViewer, App.tsx, TriagePanel, src/bug-export.ts) and test file keeps working with zero
 * changes.
 */
export * from "../shared/trace.ts";
