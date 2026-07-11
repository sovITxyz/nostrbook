import { Hono } from "hono";
import type { AppEnv, DispatchEnv, Site } from "./types";
import { guard } from "./middleware/guard";
import { tenant } from "./middleware/tenant";
import { cache } from "./middleware/cache";
import { mainRoutes } from "./routes/main";
import { tenantRoutes } from "./routes/tenant";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { wellknownRoutes } from "./routes/wellknown";

/**
 * App assembly.
 *
 * Outer app: guard (host classes) → tenant (site resolution) → dispatch.
 * Dispatch sub-fetches the main or blog sub-app, injecting the resolved Site
 * into the sub-app's env as `SITE` so handlers can read c.var.site.
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
mainApp.route("/", mainRoutes);
mainApp.route("/auth", authRoutes);
mainApp.route("/dashboard", dashboardRoutes);
mainApp.route("/api", apiRoutes);
mainApp.route("/.well-known", wellknownRoutes);

// --- Blog site (subdomains) --------------------------------------------------
const blogApp = siteFromEnv(new Hono<DispatchEnv>());
// Edge cache for public tenant GETs (after site injection, before routes).
blogApp.use("*", cache);
blogApp.route("/", tenantRoutes);

// --- Outer app ----------------------------------------------------------------
export const app = new Hono<AppEnv>();

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
