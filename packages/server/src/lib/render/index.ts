/**
 * Inline template rendering (M1 stopgap).
 *
 * The middleware pipeline (Filter → Enricher → Template) lands in M2. Until
 * then, this module does a one-shot Handlebars render of the configured
 * template straight into `EventMessage.formatted`, so the adapter has a body
 * to send. When no template is configured for the event, a minimal default
 * message is used so delivery never silently sends nothing.
 *
 * M2 will replace this with the Template middleware; this module then either
 * becomes the default-template fallback or is removed.
 */
import Handlebars from "handlebars";
import type { EventMessage } from "../../types";

const DEFAULT_TEMPLATE = `**{{event}}**{{#if action}} · {{action}}{{/if}}
**Repo**: {{repository.full_name}}
**User**: {{actor.login}}`;

/** Render the given Handlebars source against the event, filling formatted. */
export function renderFormatted(
  message: EventMessage,
  templateSource: string | undefined,
): EventMessage {
  const source = templateSource && templateSource.trim().length > 0
    ? templateSource
    : DEFAULT_TEMPLATE;
  const compiled = Handlebars.compile(source, { noEscape: true });
  const body = compiled(message);
  return {
    ...message,
    formatted: {
      title: `${message.event} · ${message.repository.full_name}`,
      body,
    },
  };
}
