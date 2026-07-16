/**
 * POST /webhook — GitHub webhook ingestion.
 *
 * ★ SECURITY-CRITICAL — RAW BODY CAPTURE ★
 * GitHub computes its HMAC-SHA256 signature over the *exact raw request
 * bytes*. We capture the raw body in an `onParse` lifecycle hook, which runs
 * BEFORE Elysia's default body parser consumes the stream. The captured
 * bytes are verified against the `X-Hub-Signature-256` header; only on
 * success do we JSON.parse them. We never re-serialize and re-sign.
 *
 * See src/lib/verify/github.ts for the verification contract.
 */
import { Elysia } from "elysia";
import { verifyGitHubSignature } from "../lib/verify/github";
import { matchRoute, findTemplate } from "../lib/config";
import type { SeedConfig } from "../lib/config";
import { dispatch } from "../lib/dispatcher";
import { renderFormatted } from "../lib/render";
import type { AdapterRegistry } from "../lib/adapters/types";
import type { EventMessage } from "../types";

/** Deps injected by the server entry: config + adapters + the GH secret. */
export interface WebhookDeps {
  config: SeedConfig | null;
  adapters: AdapterRegistry;
  /** GitHub webhook secret (from GITHUB_WEBHOOK_SECRET env). Empty = skip verify. */
  secret: string;
}

/** Store shape used to pass the captured raw body from onParse to the handler. */
interface RawBodyStore {
  rawBody?: string;
}

/** Build a GitHub payload's common fields into an EventMessage. */
function buildEventMessage(
  id: string,
  eventType: string,
  payload: Record<string, unknown>,
): EventMessage {
  const repository = (payload.repository ?? {}) as {
    full_name?: string;
    html_url?: string;
  };
  // Org-scoped events (organization / member / team / ...) have NO top-level
  // `repository`. Fall back to the `organization` object so downstream cards
  // show the org name instead of "unknown/unknown" and links resolve.
  // (See issue #6.)
  const organization = (payload.organization ?? {}) as {
    login?: string;
    html_url?: string;
    url?: string;
  };
  const sender = (payload.sender ?? {}) as { login?: string; avatar_url?: string };
  const fullName = repository.full_name ?? organization.login ?? "unknown/unknown";
  const htmlUrl = repository.html_url ?? organization.html_url ?? organization.url ?? "";
  return {
    id,
    event: eventType,
    action: typeof payload.action === "string" ? payload.action : undefined,
    repository: {
      full_name: fullName,
      html_url: htmlUrl,
    },
    actor: {
      login: sender.login ?? "unknown",
      avatar_url: sender.avatar_url ?? "",
    },
    payload,
    ref: typeof payload.ref === "string" ? payload.ref : undefined,
    metadata: {},
  };
}

/**
 * Build the webhook route with injected deps.
 *
 * Why a factory: the route needs the loaded config + adapter registry + the
 * GitHub secret, which are built once at startup in index.ts. Injecting them
 * keeps the route pure and testable (webhook.test.ts passes a fake registry).
 */
export function buildWebhookRoute(deps: WebhookDeps) {
  return new Elysia({ name: "webhook" })
    .state("rawBody", "")
    .onParse(({ request, store, path }) => {
      if (!path.includes("/webhook")) return;
      // Read the raw bytes ONCE before any default parsing. Returning the
      // string makes it `context.body`; we also stash it for the handler.
      // The stream is read exactly once and forwarded as the body.
      return request.text().then((raw) => {
        (store as RawBodyStore).rawBody = raw;
        return raw;
      });
    })
    .post(
      "/webhook",
      async ({ store, headers, set }) => {
        const eventType = headers["x-github-event"] ?? "ping";

        // GitHub sends a `ping` when a webhook is first registered; ack it.
        if (eventType === "ping") {
          return { status: "ok", event: "ping" };
        }

        const raw = (store as RawBodyStore).rawBody ?? "";
        const signature = headers["x-hub-signature-256"] ?? "";

        // Verify the signature (skip only when no secret is configured, e.g.
        // local dev — production MUST set GITHUB_WEBHOOK_SECRET).
        if (deps.secret) {
          const ok = verifyGitHubSignature(
            new TextEncoder().encode(raw),
            signature,
            deps.secret,
          );
          if (!ok) {
            set.status = 401;
            return { status: "error", detail: "invalid signature" };
          }
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          set.status = 400;
          return { status: "error", detail: "invalid JSON body" };
        }

        const deliveryId = headers["x-github-delivery"] ?? crypto.randomUUID();
        const message = buildEventMessage(deliveryId, eventType, payload);

        if (!deps.config) {
          return { status: "no_route", event: eventType, reason: "no config loaded" };
        }

        const matched = matchRoute(deps.config, message);
        if (!matched) {
          return {
            status: "no_route",
            event: eventType,
            repo: message.repository.full_name,
          };
        }

        const template = findTemplate(deps.config, eventType)?.template;
        const rendered = renderFormatted(message, template);

        const channelId = (deps.config.channels ?? []).indexOf(matched.channel);
        const result = await dispatch(
          rendered,
          matched.channel,
          deps.adapters,
          channelId,
        );

        return {
          status: result.status,
          event: eventType,
          repo: message.repository.full_name,
          route: matched.route.name,
          channel: matched.channel.name,
          ...(result.status === "fail" ? { error: result.error } : {}),
        };
      },
    );
}
