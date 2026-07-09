export type ActiveView = "finder" | "review" | "admin";

const viewPaths: Record<ActiveView, string> = {
  finder: "/",
  review: "/review",
  admin: "/admin"
};

export function activeViewFromPathname(pathname: string): ActiveView {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/review") return "review";
  if (normalized === "/admin") return "admin";
  return "finder";
}

export function pathnameForActiveView(view: ActiveView) {
  return viewPaths[view];
}
