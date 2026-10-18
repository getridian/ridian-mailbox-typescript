import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailbox } from "../dist/index.js";
const payload = {
  mailbox: {
    id: "one",
    address: "calm-panda-1234@example.test",
    ownership: "unclaimed",
    capabilities: { receive: true },
    limits: null,
  },
  access_token: "ridian_mailbox_" + "a".repeat(64),
  claim_secret: "b".repeat(64),
  claim_url: "https://console.example.test/mailbox/claim",
};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ridian-sdk-"));
  const path = join(dir, "state.json");
  const original = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  });
  return {
    path,
    dir,
    client: new Mailbox({ baseUrl: "https://api.example.test", state: path }),
  };
}
test("setup persists before HTTP and recovers the same proof after a lost response", async (t) => {
  const { path, client } = await fixture(t);
  let first,
    calls = 0;
  globalThis.fetch = async (url, init) => {
    const state = JSON.parse(await readFile(path, "utf8"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(init.headers.Authorization, "Bearer " + state.setup_token);
    if (!calls++) {
      first = state.setup_token;
      throw Error("lost");
    }
    assert.equal(state.setup_token, first);
    return Response.json(payload);
  };
  await assert.rejects(client.setup(), {
    code: "transport_interrupted_reuse_state",
  });
  assert.deepEqual(await client.setup(), payload.mailbox);
  assert.equal(JSON.stringify(client), "{}");
});
test("origin mismatch, public files and symlinks never send credentials", async (t) => {
  const { path, dir, client } = await fixture(t);
  globalThis.fetch = async () => Response.json(payload);
  await client.setup();
  globalThis.fetch = () => {
    throw Error("must not fetch");
  };
  await assert.rejects(
    new Mailbox({ baseUrl: "https://other.example", state: path }).status(),
    { code: "state_origin_mismatch" },
  );
  await chmod(path, 0o644);
  await assert.rejects(client.status(), { code: "state_must_be_private_file" });
  await chmod(path, 0o600);
  const link = join(dir, "link.json");
  await symlink(path, link);
  await assert.rejects(
    new Mailbox({ baseUrl: "https://api.example.test", state: link }).status(),
    { code: "private_storage_unavailable" },
  );
});
test("pagination follows empty pages and event acknowledgement is explicit", async (t) => {
  const { path, client } = await fixture(t);
  globalThis.fetch = async () => Response.json(payload);
  await client.setup();
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (!calls++) return Response.json({ data: [], next_cursor: "a&b" });
    assert.match(url, /cursor=a%26b/);
    return Response.json({ data: [{ id: "message" }], next_cursor: null });
  };
  const rows = [];
  for await (const row of client.iterMessages()) rows.push(row);
  assert.deepEqual(rows, [{ id: "message" }]);
  globalThis.fetch = async () =>
    Response.json({
      data: [],
      next_cursor: "next",
      has_more: false,
      poll_after_ms: 5000,
    });
  await client.events();
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).event_cursor,
    undefined,
  );
  await client.acknowledgeEvents("next");
  assert.equal(JSON.parse(await readFile(path, "utf8")).event_cursor, "next");
});
test("redirects are rejected and rate-limit retries cannot bypass cooldown", async (t) => {
  const { client } = await fixture(t);
  globalThis.fetch = async () => Response.json(payload);
  await client.setup();
  globalThis.fetch = async (_, init) => {
    assert.equal(init.redirect, "manual");
    return new Response("secret", {
      status: 302,
      headers: { Location: "https://elsewhere.example" },
    });
  };
  await assert.rejects(client.status(), { code: "redirect_refused" });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("secret", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  };
  await assert.rejects(client.status(), {
    code: "rate_limit",
    status: 429,
    retryAfter: 60,
  });
  await assert.rejects(client.status(), { code: "rate_limit" });
  assert.equal(calls, 1);
});
test("authenticated binary attachments and explicit webhook/revoke requests", async (t) => {
  const { client, path } = await fixture(t);
  globalThis.fetch = async () => Response.json(payload);
  await client.setup();
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith("/attachments/a%2Fb"));
    assert.equal(init.headers.Authorization, "Bearer " + payload.access_token);
    return new Response(new Uint8Array([0, 255, 42]));
  };
  assert.deepEqual(
    await client.attachment("a/b"),
    new Uint8Array([0, 255, 42]),
  );
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith("/webhook"));
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      url: "https://receiver.example",
      signing_secret: "c".repeat(64),
    });
    return Response.json({
      url: "https://receiver.example",
      status: "active",
      attempts: 0,
    });
  };
  await client.setWebhook({
    url: "https://receiver.example",
    signingSecret: "c".repeat(64),
  });
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith("/current/access"));
    assert.equal(init.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  await client.revoke();
  assert.ok(await readFile(path, "utf8"));
});
test("webhook resume sends no body, as the contract requires", async (t) => {
  const { client } = await fixture(t);
  globalThis.fetch = async () => Response.json(payload);
  await client.setup();
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith("/current/webhook/resume"));
    assert.equal(init.method, "POST");
    assert.equal(init.body, undefined);
    assert.equal(init.headers["Content-Type"], undefined);
    return new Response(null, { status: 204 });
  };
  assert.equal(await client.resumeWebhook(), undefined);
});
test("default origin is production and explicit origins stay isolated", async (t) => {
  const { path } = await fixture(t);
  const client = new Mailbox({ state: path });
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://services.getridian.com/v1/mailboxes");
    return Response.json(payload);
  };
  await client.setup();
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).base_url,
    "https://services.getridian.com",
  );
});
test("repeated pagination cursors fail rather than loop forever", async (t) => {
  const { client } = await fixture(t);
  globalThis.fetch = async () => Response.json(payload);
  await client.setup();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ data: [], next_cursor: "same" });
  };
  await assert.rejects(
    async () => {
      for await (const row of client.iterMessages())
        assert.fail(JSON.stringify(row));
    },
    { code: "pagination_cursor_repeated" },
  );
  assert.equal(calls, 2);
});
test("FIFO state files are rejected without blocking", async (t) => {
  const { path, client } = await fixture(t);
  const { execFileSync } = await import("node:child_process");
  execFileSync("mkfifo", [path]);
  await chmod(path, 0o600);
  globalThis.fetch = () => assert.fail("must not fetch");
  await assert.rejects(client.status(), { code: "state_must_be_private_file" });
});
test("error bodies and transport messages do not expose credentials", async (t) => {
  const { client } = await fixture(t);
  globalThis.fetch = async () => Response.json(payload);
  await client.setup();
  for (const status of [401, 403, 404, 409, 500, 503]) {
    globalThis.fetch = async () =>
      new Response(payload.access_token, { status });
    await assert.rejects(
      client.status(),
      (error) =>
        error.status === status &&
        !String(error).includes(payload.access_token),
    );
  }
  globalThis.fetch = async () => {
    throw new Error(payload.access_token);
  };
  await assert.rejects(client.status(), {
    code: "transport_interrupted_reuse_state",
  });
});
