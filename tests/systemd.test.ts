import { describe, expect, it } from "vitest";
import { buildUnit, serviceName, unitPath, type UnitParams } from "../src/core/systemd.js";

const base: UnitParams = {
  profile: "simba",
  user: "thanhnc",
  home: "/home/thanhnc",
  nodePath: "/opt/node/bin/node",
  scriptPath: "/opt/cloudtunnel/dist/index.js",
};

describe("serviceName / unitPath", () => {
  it("derives the unit name and path from the profile", () => {
    expect(serviceName("simba")).toBe("cloudtunnel-simba.service");
    expect(unitPath("simba")).toBe("/etc/systemd/system/cloudtunnel-simba.service");
  });
});

describe("buildUnit", () => {
  it("runs the profile in the foreground with force and User set", () => {
    const unit = buildUnit(base);
    expect(unit).toContain("ExecStart=/opt/node/bin/node /opt/cloudtunnel/dist/index.js run simba -f");
    expect(unit).toContain("User=thanhnc");
    expect(unit).toContain("Environment=HOME=/home/thanhnc");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Restart=on-failure");
  });

  it("puts the node bin dir on PATH so systemd's minimal env finds node", () => {
    expect(buildUnit(base)).toContain("Environment=PATH=/opt/node/bin:");
  });

  it("appends --protocol only when a transport is set", () => {
    expect(buildUnit(base)).not.toContain("--protocol");
    expect(buildUnit({ ...base, protocol: "http2" })).toContain("run simba -f --protocol http2");
  });
});
