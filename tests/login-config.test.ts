import { describe, expect, it } from "vitest";
import { buildMergedConfig } from "../src/commands/login.js";

describe("buildMergedConfig (re-login merge)", () => {
  it("preserves defaultZone and other saved fields when a re-login doesn't touch them", () => {
    const prev = { apiToken: "old", accountId: "acc-old", defaultZone: "abc.com", serviceCheckVersion: "0.12.1" };
    const merged = buildMergedConfig(prev, { token: "new", fromEnv: false, accountId: "acc-new" });
    expect(merged.defaultZone).toBe("abc.com");
    expect(merged.serviceCheckVersion).toBe("0.12.1");
    expect(merged.apiToken).toBe("new");
    expect(merged.accountId).toBe("acc-new");
  });

  it("overrides defaultZone when the login provides a new one", () => {
    const merged = buildMergedConfig(
      { defaultZone: "old.com" },
      { token: "t", fromEnv: false, accountId: "a", defaultZone: "new.com" },
    );
    expect(merged.defaultZone).toBe("new.com");
  });

  it("does not persist an env-sourced token", () => {
    const merged = buildMergedConfig({}, { token: "env-tok", fromEnv: true, accountId: "a" });
    expect(merged.apiToken).toBeUndefined();
  });
});
