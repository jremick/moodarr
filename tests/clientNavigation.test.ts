import { describe, expect, it } from "vitest";
import { activeViewFromPathname, pathnameForActiveView } from "../src/client/navigation";

describe("client navigation", () => {
  it.each([
    ["/", "finder"],
    ["/review", "review"],
    ["/review/", "review"],
    ["/admin", "admin"],
    ["/admin/", "admin"],
    ["/unknown", "finder"]
  ] as const)("maps %s to %s", (pathname, view) => {
    expect(activeViewFromPathname(pathname)).toBe(view);
  });

  it("provides stable canonical paths", () => {
    expect(pathnameForActiveView("finder")).toBe("/");
    expect(pathnameForActiveView("review")).toBe("/review");
    expect(pathnameForActiveView("admin")).toBe("/admin");
  });
});
