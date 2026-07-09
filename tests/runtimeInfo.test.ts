import { describe, expect, it } from "vitest";
import { getRuntimeInfo } from "../src/server/runtimeInfo";

describe("runtime build information", () => {
  it("uses the package version when no build override is provided", () => {
    expect(getRuntimeInfo({})).toEqual({ version: "0.1.0-alpha.21" });
  });

  it("reports image-provided version and revision metadata", () => {
    expect(getRuntimeInfo({ MOODARR_VERSION: "0.1.0-alpha.22", MOODARR_BUILD_REVISION: "abc123" })).toEqual({
      version: "0.1.0-alpha.22",
      revision: "abc123"
    });
  });
});
