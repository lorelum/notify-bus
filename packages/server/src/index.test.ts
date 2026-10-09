import { describe, expect, it } from "bun:test";
import { buildAdapterRegistry } from "./lib/adapters";

describe("adapter registry", () => {
  it("registers the feishu adapter under the feishu type", () => {
    const registry = buildAdapterRegistry();
    expect(registry.get("feishu")?.type).toBe("feishu");
    expect(registry.get("feishu")?.capabilities.displayName).toBe("Feishu");
  });

  it("registers the outbound application bot without replacing the webhook bot", () => {
    const registry = buildAdapterRegistry();
    expect(registry.get("feishu_app")?.type).toBe("feishu_app");
    expect(registry.get("feishu_app")?.capabilities.messageTypes).toEqual(["interactive"]);
    expect(registry.get("feishu")?.type).toBe("feishu");
  });

  it("reports feishu supports interactive cards", () => {
    const registry = buildAdapterRegistry();
    expect(registry.get("feishu")?.capabilities.supportsCards).toBe(true);
  });
});
