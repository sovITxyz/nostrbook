// Migration application check: the migrations apply to local D1 (done by the
// test setup file) and produce the contracted schema.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("migrations/0001_init.sql", () => {
  it("creates all contracted tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const table of [
      "users",
      "events",
      "profiles",
      "reserved_handles",
      "rate_limits",
      "posts_fts",
    ]) {
      expect(names, `table ${table} must exist`).toContain(table);
    }
  });

  it("creates the events feed index", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_feed'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("idx_events_feed");
  });

  it("seeds the reserved handles", async () => {
    const { results } = await env.DB.prepare(
      "SELECT handle FROM reserved_handles ORDER BY handle",
    ).all<{ handle: string }>();
    const handles = results.map((r) => r.handle);
    expect(handles).toEqual(
      [
        "www",
        "api",
        "admin",
        "staff",
        "static",
        "mail",
        "blog",
        "help",
        "about",
        "root",
        "_dmarc",
      ].sort(),
    );
  });

  it("enforces the replaceable uniqueness constraint on events", async () => {
    await env.DB.prepare(
      "INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw) VALUES ('e1','pk1',30023,'slug',1,'','[]','sig','{}')",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw) VALUES ('e2','pk1',30023,'slug',2,'','[]','sig','{}')",
      ).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("posts_fts is a working FTS5 table (insert + MATCH)", async () => {
    await env.DB.prepare(
      "INSERT INTO posts_fts (rowid, title, summary, content) VALUES (1, 'Hello world', 'a summary', 'searchable body text')",
    ).run();
    const { results } = await env.DB.prepare(
      "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'searchable'",
    ).all<{ rowid: number }>();
    expect(results.length).toBe(1);
  });

  it("users.handle is unique case-insensitively (COLLATE NOCASE)", async () => {
    await env.DB.prepare(
      "INSERT INTO users (pubkey, handle, claimed_at) VALUES ('pkA', 'CaseTest', '2026-01-01')",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO users (pubkey, handle, claimed_at) VALUES ('pkB', 'casetest', '2026-01-01')",
      ).run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe("migrations/0003_login_nonces.sql", () => {
  it("creates login_nonces with the contracted shape and expiry index", async () => {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='login_nonces'",
    ).first<{ name: string }>();
    expect(table?.name).toBe("login_nonces");
    const index = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_login_nonces_expiry'",
    ).first<{ name: string }>();
    expect(index?.name).toBe("idx_login_nonces_expiry");
    // nonce is the primary key: a duplicate insert must fail.
    await env.DB.prepare(
      "INSERT INTO login_nonces (nonce, expires_at) VALUES ('n1', 1)",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO login_nonces (nonce, expires_at) VALUES ('n1', 2)",
      ).run(),
    ).rejects.toThrow(/UNIQUE|PRIMARY/);
  });
});

describe("migrations/0004_delete_horizons.sql", () => {
  it("creates delete_horizons and the MAX-keeping upsert works", async () => {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='delete_horizons'",
    ).first<{ name: string }>();
    expect(table?.name).toBe("delete_horizons");

    // The exact upsert applyDelete issues: the horizon only ever RISES —
    // a replayed older delete must not lower a stored newer horizon.
    const upsert = (deletedAt: number) =>
      env.DB.prepare(
        `INSERT INTO delete_horizons (address, deleted_at) VALUES (?, ?)
         ON CONFLICT(address) DO UPDATE SET
           deleted_at = MAX(delete_horizons.deleted_at, excluded.deleted_at)`,
      ).bind("30023:pk-test:slug", deletedAt);
    await upsert(100).run();
    await upsert(200).run(); // newer delete raises the horizon
    await upsert(150).run(); // older replay must NOT lower it
    const row = await env.DB.prepare(
      "SELECT deleted_at FROM delete_horizons WHERE address = ?",
    )
      .bind("30023:pk-test:slug")
      .first<{ deleted_at: number }>();
    expect(row?.deleted_at).toBe(200);
  });
});
