const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");

test("Open Relay static auth returns short-lived TURN credentials without an API call", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  const now = 1_700_000_000_000;
  const servers = await createConfiguredIceServers(
    {
      TURN_PROVIDER: "openrelay",
      TURN_CREDENTIAL_TTL_SECONDS: "600",
    },
    async () => assert.fail("Open Relay static auth must not call a provider API"),
  );

  assert.equal(servers.length, 2);
  assert.ok(servers[0].urls.includes("stun:stun.l.google.com:19302"));
  const turnServer = servers[1];
  assert.deepEqual(turnServer.urls, [
    "turn:staticauth.openrelay.metered.ca:80?transport=udp",
    "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
    "turn:staticauth.openrelay.metered.ca:443?transport=udp",
    "turns:staticauth.openrelay.metered.ca:443?transport=tcp",
  ]);
  assert.equal(turnServer.credentialType, "password");
  assert.match(turnServer.username, /^\d+:[0-9a-f-]{36}$/);
  assert.equal(
    turnServer.credential,
    createHmac("sha1", "openrelayprojectsecret")
      .update(turnServer.username)
      .digest("base64"),
  );
});

test("Open Relay static auth honors the configured credential lifetime", async () => {
  const { createMeteredOpenRelayIceServers } = await import("../src/lib/ice-servers.js");
  const now = 1_700_000_000_000;
  const [stunServer, turnServer] = createMeteredOpenRelayIceServers(
    { TURN_CREDENTIAL_TTL_SECONDS: "600" },
    now,
  );
  assert.ok(stunServer.urls.includes("stun:stun.l.google.com:19302"));
  assert.ok(turnServer.username.startsWith("1700000600:"));
});