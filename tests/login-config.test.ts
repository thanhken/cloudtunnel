import { describe, expect, it } from "vitest";
import { buildMergedConfig } from "../src/commands/login.js";

describe("buildMergedConfig (re-login merge)", () => {
  it("preserves apiBase / relaySecret / defaultZone when a re-login doesn't touch them", () => {
    const prev = {
      apiToken: "old", accountId: "acc-old", defaultZone: "abc.com",
      apiBase: "https://cfapi.abc.com/client/v4", relaySecret: "sek",
    };
    const merged = buildMergedConfig(prev, { token: "new", fromEnv: false, accountId: "acc-new" });
    expect(merged.apiBase).toBe("https://cfapi.abc.com/client/v4");
    expect(merged.relaySecret).toBe("sek");
    expect(merged.defaultZone).toBe("abc.com");
    expect(merged.apiToken).toBe("new");
    expect(merged.accountId).toBe("acc-new");
  });

  it("overrides apiBase / relaySecret / defaultZone when the login provides new ones", () => {
    const merged = buildMergedConfig(
      { apiBase: "https://old/client/v4", relaySecret: "old-sek", defaultZone: "old.com" },
      { token: "t", fromEnv: false, accountId: "a", defaultZone: "new.com", apiBase: "https://new/client/v4", relaySecret: "new-sek" },
    );
    expect(merged.apiBase).toBe("https://new/client/v4");
    expect(merged.relaySecret).toBe("new-sek");
    expect(merged.defaultZone).toBe("new.com");
  });

  it("does not persist an env-sourced token", () => {
    const merged = buildMergedConfig({}, { token: "env-tok", fromEnv: true, accountId: "a" });
    expect(merged.apiToken).toBeUndefined();
  });
});
