import { describe, expect, it } from "vitest";
import { buildUpArgs, fqdnFor, serviceSlug, type ServiceDescriptor } from "../src/core/service-exec.js";
import * as systemd from "../src/core/service-systemd.js";
import * as launchd from "../src/core/service-launchd.js";
import * as windows from "../src/core/service-windows.js";

const desc: ServiceDescriptor = {
  fqdn: "api.abc.com",
  slug: "api-abc-com",
  argv: ["up", "api:8080@localhost", "-d", "abc.com", "-f", "-y"],
  nodePath: "/opt/node/bin/node",
  scriptPath: "/opt/cloudtunnel/dist/index.js",
  user: "thanhnc",
  home: "/home/thanhnc",
  logFile: "/home/thanhnc/.config/cloudtunnel/logs/api-abc-com.service.log",
};

describe("service-exec", () => {
  it("builds the up args, adding --proto/--protocol only when needed", () => {
    expect(buildUpArgs({ subdomain: "api", port: 8080, host: "localhost", zone: "abc.com", proto: "http" }))
      .toEqual(["up", "api:8080@localhost", "-d", "abc.com", "-f", "-y"]);
    expect(buildUpArgs({ subdomain: "api", port: 8080, zone: "abc.com", proto: "https", protocol: "http2" }))
      .toEqual(["up", "api:8080", "-d", "abc.com", "--proto", "https", "--protocol", "http2", "-f", "-y"]);
  });

  it("slugs the fqdn and maps apex to the bare zone", () => {
    expect(serviceSlug("api.abc.com")).toBe("api-abc-com");
    expect(fqdnFor("@", "abc.com")).toBe("abc.com");
    expect(fqdnFor("api", "abc.com")).toBe("api.abc.com");
  });
});

describe("systemd backend", () => {
  it("names the unit from the fqdn slug", () => {
    expect(systemd.label("api.abc.com")).toBe("cloudtunnel-api-abc-com.service");
  });
  it("re-runs the up args in the foreground with node/PATH/restart", () => {
    const u = systemd.buildUnit(desc);
    expect(u).toContain("ExecStart=/opt/node/bin/node /opt/cloudtunnel/dist/index.js up api:8080@localhost -d abc.com -f -y");
    expect(u).toContain("Environment=PATH=/opt/node/bin:");
    expect(u).toContain("User=thanhnc");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=multi-user.target");
  });
});

describe("launchd backend", () => {
  it("names a reverse-DNS agent label", () => {
    expect(launchd.label("api.abc.com")).toBe("com.cloudtunnel.api-abc-com");
  });
  it("emits a RunAtLoad + KeepAlive agent with the full ProgramArguments", () => {
    const p = launchd.buildPlist(desc);
    expect(p).toContain("<key>Label</key><string>com.cloudtunnel.api-abc-com</string>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("<string>/opt/node/bin/node</string>");
    expect(p).toContain("<string>up</string>");
    expect(p).toContain("<string>api:8080@localhost</string>");
  });
});

describe("windows backend", () => {
  it("names a task under the cloudtunnel folder", () => {
    expect(windows.label("api.abc.com")).toBe("cloudtunnel\\api-abc-com");
  });
  it("emits a LeastPrivilege logon task with restart-on-failure and the exec args", () => {
    const x = windows.buildTaskXml(desc);
    expect(x).toContain("<LogonTrigger>");
    expect(x).toContain("<UserId>thanhnc</UserId>"); // trigger + principal scoped to the user
    expect(x).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(x).toContain("<RestartOnFailure>");
    expect(x).toContain("<Command>/opt/node/bin/node</Command>");
    expect(x).toContain("up api:8080@localhost -d abc.com -f -y");
  });
});
