// P4 NIP-05: /.well-known/nostr.json?name=X → {names:{X:<pubkey_hex>}} with
// CORS *, case-insensitive lookup, {names:{}} for unknown/blocked/missing.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedAlice, seedBlockedMallory, ALICE_PK } from "../helpers";

type Nip05Body = {
  names: Record<string, string>;
  relays?: Record<string, string[]>;
};

async function nip05(query: string): Promise<{ res: Response; body: Nip05Body }> {
  const res = await SELF.fetch(
    `https://nbread.lol/.well-known/nostr.json${query}`,
  );
  const body = (await res.json()) as Nip05Body;
  return { res, body };
}

beforeAll(async () => {
  await seedAlice();
  await seedBlockedMallory();
});

describe("/.well-known/nostr.json (NIP-05)", () => {
  it("returns the contract shape with CORS * for a claimed handle", async () => {
    const { res, body } = await nip05("?name=alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.names).toEqual({ alice: ALICE_PK });
    // Optional relays object: the first-party relay hint leads, then the
    // env.RELAYS defaults.
    expect(body.relays?.[ALICE_PK]?.[0]).toBe("wss://nbread.lol/relay");
    expect(body.relays?.[ALICE_PK]).toContain("wss://relay.damus.io");
  });

  it("looks up case-insensitively and echoes the queried spelling", async () => {
    const { res, body } = await nip05("?name=ALICE");
    expect(res.status).toBe(200);
    expect(body.names).toEqual({ ALICE: ALICE_PK });
  });

  it("returns empty names for an unknown name", async () => {
    const { res, body } = await nip05("?name=nobody-here");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(body).toEqual({ names: {} });
  });

  it("returns empty names when the name param is missing or malformed", async () => {
    expect((await nip05("")).body).toEqual({ names: {} });
    expect((await nip05("?name=")).body).toEqual({ names: {} });
    expect((await nip05(`?name=${"x".repeat(65)}`)).body).toEqual({
      names: {},
    });
    expect((await nip05("?name=inj'ect%22ion")).body).toEqual({ names: {} });
  });

  it("hides blocked users", async () => {
    const { body } = await nip05("?name=blocked");
    expect(body).toEqual({ names: {} });
  });

  it("is apex-only (blog subdomains 404)", async () => {
    const res = await SELF.fetch(
      "https://alice.nbread.lol/.well-known/nostr.json?name=alice",
    );
    expect(res.status).toBe(404);
  });
});
