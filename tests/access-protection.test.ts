import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cloudflare/access.js", async (orig) => {
  const real = await orig<typeof import("../src/cloudflare/access.js")>();
  return {
    ...real,
    getAccessOrg: vi.fn(async () => ({ auth_domain: "team.cloudflareaccess.com", name: "team" })),
    listIdps: vi.fn(async () => [{ id: "otp1", type: "onetimepin", name: "" }]),
    createOtpIdp: vi.fn(async () => ({ id: "otpNew", type: "onetimepin", name: "One-time PIN" })),
    findAccessApp: vi.fn(async () => undefined),
    createAccessApp: vi.fn(async () => ({ id: "app1", name: "cloudtunnel:x", domain: "x" })),
    updateAccessApp: vi.fn(async () => ({})),
    deleteAccessApp: vi.fn(async () => {}),
  };
});
vi.mock("../src/ui/output.js", async (orig) => ({
  ...(await orig<typeof import("../src/ui/output.js")>()),
  confirm: vi.fn(async () => true),
}));

const access = await import("../src/cloudflare/access.js");
const { confirm } = await import("../src/ui/output.js");
const { CliError } = await import("../src/ui/errors.js");
const { ensureAccessApp, removeAccessApp } = await import("../src/core/access-protection.js");

const cf = { token: "t", accountId: "acc" };
const fqdn = "api.abc.com";
const managed = (include: unknown) => ({
  id: "app0", name: `cloudtunnel:${fqdn}`, domain: fqdn, policies: [{ id: "p", include }],
});

describe("ensureAccessApp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a one-time-PIN app with an inline policy for the rules", async () => {
    const r = await ensureAccessApp(cf, fqdn, ["a@x.com", "@corp.io"], { interactive: false });
    expect(r).toEqual({ appId: "app1", created: true });
    const body = vi.mocked(access.createAccessApp).mock.calls[0]![1];
    expect(body).toMatchObject({
      name: `cloudtunnel:${fqdn}`, type: "self_hosted", domain: fqdn, allowed_idps: ["otp1"],
      policies: [{ decision: "allow", include: [{ email: { email: "a@x.com" } }, { email_domain: { domain: "corp.io" } }] }],
    });
  });

  it("re-running with the same rules reuses the app without any write", async () => {
    vi.mocked(access.findAccessApp).mockResolvedValueOnce(managed([{ email: { email: "a@x.com" } }]));
    expect(await ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: false })).toEqual({ appId: "app0", created: false });
    expect(access.createAccessApp).not.toHaveBeenCalled();
    expect(access.updateAccessApp).not.toHaveBeenCalled();
  });

  it("different rules → PUT on the same app (never a duplicate)", async () => {
    vi.mocked(access.findAccessApp).mockResolvedValueOnce(managed([{ email: { email: "old@x.com" } }]));
    await ensureAccessApp(cf, fqdn, ["new@x.com"], { interactive: false });
    expect(access.updateAccessApp).toHaveBeenCalledWith(cf, "app0", expect.objectContaining({
      policies: [expect.objectContaining({ include: [{ email: { email: "new@x.com" } }] })],
    }));
    expect(access.createAccessApp).not.toHaveBeenCalled();
  });

  it("refuses to take over an Access app it did not create", async () => {
    vi.mocked(access.findAccessApp).mockResolvedValueOnce({ id: "sso", name: "Company SSO", domain: fqdn });
    await expect(ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: false })).rejects.toThrow(/not created by cloudtunnel/);
    expect(access.updateAccessApp).not.toHaveBeenCalled();
  });

  it("a POST that timed out or raced (409 11010) is resolved by looking the app up, not re-sent", async () => {
    for (const err of [new CliError("timeout"), new CliError("exists", { status: 409, cfCode: 11010 })]) {
      vi.clearAllMocks();
      vi.mocked(access.createAccessApp).mockRejectedValueOnce(err);
      vi.mocked(access.findAccessApp).mockResolvedValueOnce(undefined).mockResolvedValueOnce(managed(
        [{ email: { email: "a@x.com" } }],
      ));
      expect(await ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: false })).toEqual({ appId: "app0", created: false });
      expect(access.createAccessApp).toHaveBeenCalledTimes(1);
    }
  });

  it("maps a 403 to the scope hint with a pre-filled token link", async () => {
    vi.mocked(access.findAccessApp).mockRejectedValueOnce(new CliError("forbidden", { status: 403 }));
    const err = await ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: false }).catch((e) => e);
    expect(err.message).toMatch(/can't manage Cloudflare Access/);
    expect(err.hint).toMatch(/cloudtunnel login/);
    expect(err.hint).toMatch(/access_acct/);
  });

  it("no Zero Trust org → actionable error", async () => {
    vi.mocked(access.getAccessOrg).mockRejectedValueOnce(new CliError("not found", { status: 404 }));
    await expect(ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: true })).rejects.toThrow(/Zero Trust isn't set up/);
  });

  it("OTP missing and no other IdP → created silently", async () => {
    vi.mocked(access.listIdps).mockResolvedValueOnce([]);
    await ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: false });
    expect(access.createOtpIdp).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("OTP missing with other IdPs → asks on a TTY, refuses non-interactively", async () => {
    const others = [{ id: "g", type: "google", name: "Google" }];
    vi.mocked(access.listIdps).mockResolvedValueOnce(others);
    await ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: true });
    expect(confirm).toHaveBeenCalled();
    expect(access.createOtpIdp).toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(access.listIdps).mockResolvedValueOnce(others);
    await expect(ensureAccessApp(cf, fqdn, ["a@x.com"], { interactive: false })).rejects.toThrow(/One-time PIN login is not enabled/);
    expect(access.createOtpIdp).not.toHaveBeenCalled();
  });
});

describe("removeAccessApp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes by id; 404 counts as done", async () => {
    vi.mocked(access.deleteAccessApp).mockRejectedValueOnce(new CliError("gone", { status: 404 }));
    await expect(removeAccessApp(cf, fqdn, "app0")).resolves.toBe(true);
  });

  it("without an id only deletes a cloudtunnel-managed app", async () => {
    vi.mocked(access.findAccessApp).mockResolvedValueOnce({ id: "sso", name: "Company SSO", domain: fqdn });
    await removeAccessApp(cf, fqdn);
    expect(access.deleteAccessApp).not.toHaveBeenCalled();
  });

  it("a missing scope only warns (never blocks tunnel release)", async () => {
    vi.mocked(access.deleteAccessApp).mockRejectedValueOnce(new CliError("forbidden", { status: 403 }));
    await expect(removeAccessApp(cf, fqdn, "app0")).resolves.toBe(false);
  });
});
