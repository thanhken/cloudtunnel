import { describe, expect, it } from "vitest";
import { buildUnit, serviceName, unitPath, type UnitParams } from "../src/core/systemd.js";

const base: UnitParams = {
  fqdn: "api.abc.com",
  spec: "api:8080@localhost",
  zone: "abc.com",
  proto: "http",
  user: "thanhnc",
  home: "/home/thanhnc",
  nodePath: "/opt/node/bin/node",
  scriptPath: "/opt/cloudtunnel/dist/index.js",
};

describe("serviceName / unitPath", () => {
  it("derives the unit name and path from the fqdn (slugged, unique per domain)", () => {
    expect(serviceName("api.abc.com")).toBe("cloudtunnel-api-abc-com.service");
    expect(unitPath("api.abc.com")).toBe("/etc/systemd/system/cloudtunnel-api-abc-com.service");
    expect(serviceName("api.xyz.io")).toBe("cloudtunnel-api-xyz-io.service");
  });
});

describe("buildUnit", () => {
  it("re-runs `up <spec> -d <zone>` in the foreground with -f -y and User set", () => {
    const unit = buildUnit(base);
    expect(unit).toContain("ExecStart=/opt/node/bin/node /opt/cloudtunnel/dist/index.js up api:8080@localhost -d abc.com -f -y");
    expect(unit).toContain("User=thanhnc");
    expect(unit).toContain("Environment=HOME=/home/thanhnc");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Restart=on-failure");
  });

  it("puts the node bin dir on PATH so systemd's minimal env finds node", () => {
    expect(buildUnit(base)).toContain("Environment=PATH=/opt/node/bin:");
  });

  it("appends --proto only for https targets", () => {
    expect(buildUnit(base)).not.toContain("--proto");
    expect(buildUnit({ ...base, proto: "https" })).toContain("--proto https");
  });

  it("appends --protocol only when a transport is set", () => {
    expect(buildUnit(base)).not.toContain("--protocol");
    expect(buildUnit({ ...base, protocol: "http2" })).toContain("-d abc.com --protocol http2 -f -y");
  });
});
