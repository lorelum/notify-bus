/** Shared schema 2.0 serialization for webhook and application bot transports. */
import type { FeishuCard } from "./feishu-card-kit";

export function serializeFeishuCard(card: FeishuCard): Record<string, unknown> {
  const header: Record<string, unknown> = {
    title: { tag: "plain_text", content: card.header.title },
    template: card.header.template,
  };
  if (card.header.subtitle) header.subtitle = { tag: "plain_text", content: card.header.subtitle };
  if (card.header.badges?.length) {
    header.text_tag_list = card.header.badges.map((badge) => ({
      tag: "text_tag",
      text: { tag: "plain_text", content: badge.text },
      color: badge.color,
    }));
  }
  return { schema: "2.0", header, body: { elements: card.elements } };
}
