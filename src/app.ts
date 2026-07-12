import { Hono } from "hono";
import type { AppEnv, DispatchEnv, Site } from "./types";
import { securityHeaders } from "./middleware/headers";
import { guard } from "./middleware/guard";
import { tenant } from "./middleware/tenant";
import { cache } from "./middleware/cache";
import { csrf } from "./middleware/csrf";
import { session } from "./middleware/session";
import { mainRoutes } from "./routes/main";
import { tenantRoutes } from "./routes/tenant";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { adminRoutes } from "./routes/admin";
import { wellknownRoutes } from "./routes/wellknown";

/**
 * App assembly.
 *
 * Outer app: securityHeaders (stamps every response, wraps everything) →
 * guard (host classes) → tenant (site resolution) → dispatch. Dispatch
 * sub-fetches the main or blog sub-app, injecting the resolved Site into the
 * sub-app's env as `SITE` so handlers can read c.var.site.
 */

/** Copies the injected SITE from env into c.var.site for sub-app handlers. */
const siteFromEnv = (app: Hono<DispatchEnv>): Hono<DispatchEnv> => {
  app.use("*", async (c, next) => {
    c.set("site", c.env.SITE);
    await next();
  });
  return app;
};

// --- Main site (apex) --------------------------------------------------------
const mainApp = siteFromEnv(new Hono<DispatchEnv>());
// CSRF first (same-origin proof for unsafe methods, JSON APIs included),
// then sessions — both main-site only, both before every route.
mainApp.use("*", csrf);
mainApp.use("*", session);
mainApp.route("/", mainRoutes);
mainApp.route("/", authRoutes); // /login, /login/challenge, /logout
mainApp.route("/dashboard", dashboardRoutes);
mainApp.route("/admin", adminRoutes); // P7 blocklist admin (gated by ADMIN_PUBKEY)
mainApp.route("/api", apiRoutes);
mainApp.route("/.well-known", wellknownRoutes);

// --- Blog site (subdomains) --------------------------------------------------
const blogApp = siteFromEnv(new Hono<DispatchEnv>());
// Edge cache for public tenant GETs (after site injection, before routes).
blogApp.use("*", cache);
blogApp.route("/", tenantRoutes);

// --- Outer app ----------------------------------------------------------------
export const app = new Hono<AppEnv>();

// Security headers FIRST so they wrap every outcome — including guard 404s
// (unknown hosts), tenant 404s (unclaimed/blocked subdomains), and cache
// hits served inside the blog sub-app.
app.use("*", securityHeaders);
app.use("*", guard);
app.use("*", tenant);

app.all("*", async (c) => {
  const site: Site = c.var.site;
  const target = site.type === "main" ? mainApp : blogApp;
  return target.fetch(
    c.req.raw,
    { ...c.env, SITE: site },
    c.executionCtx,
  );
});
