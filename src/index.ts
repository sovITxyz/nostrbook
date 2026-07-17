import { app } from "./app";
import { runRefresh } from "./cron/refresh";
import { sweepRateLimits } from "./services/ratelimit";

// First-party relay Durable Object (wrangler.jsonc durable_objects binding
// RELAY_DO + migrations v1 new_sqlite_classes — the free-plan variant).
export { RelayDO } from "./relay/do";

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runRefresh(env, ctx);
    // IP-keyed counter rows are retention-bounded (see privacy policy).
    await sweepRateLimits(env);
  },
} satisfies ExportedHandler<Env>;
