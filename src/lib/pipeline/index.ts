/**
 * Middleware pipeline.
 *
 * STATUS: scaffold. Implemented in M2.
 *
 * Each middleware is `(event, next) => void | Promise<void>`:
 *   - may inspect/mutate `event` (e.g. write to `event.metadata`)
 *   - may short-circuit by NOT calling `next()` (filtering)
 *   - order + enable/disable are configurable
 *
 * Built-in middlewares (M2):
 *   - Filter    : drop events by event_type / repo glob / actor / action
 *   - Enricher  : extract commit list (push, ≤5), changed-file count (PR)
 *   - Template  : render Handlebars template → event.formatted
 */
import type { EventMessage } from "../../types";

export type Middleware = (
  event: EventMessage,
  next: () => Promise<void>,
) => Promise<void> | void;

/**
 * Run an event through a chain of middlewares, in order.
 *
 * STATUS: stub. M2 implements the real runner.
 */
export async function runPipeline(
  _event: EventMessage,
  _middlewares: readonly Middleware[],
): Promise<void> {
  // M2: reduce the chain; a middleware that doesn't call next() short-circuits.
}
