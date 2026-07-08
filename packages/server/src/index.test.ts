import { describe, expect, it } from "bun:test";
import { buildAdapterRegistry } from "./lib/adapters";

describe("adapter registry", () => {
  it("registers the feishu adapter under the feishu type", () => {
    const registry = buildAdapterRegistry();
    expect(registry.get("feishu")?.type).toBe("feishu");
    expect(registry.get("feishu")?.capabilities.displayName).toBe("Feishu");
  });

  it("reports feishu supports interactive cards", () => {
    const registry = buildAdapterRegistry();
    expect(registry.get("feishu")?.capabilities.supportsCards).toBe(true);
  });
});
