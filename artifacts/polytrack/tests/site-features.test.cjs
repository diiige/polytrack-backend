const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");
const { URLSearchParams } = require("node:url");
const vm = require("node:vm");

const source = readFileSync(
  require("node:path").join(__dirname, "../public/site-features.js"),
  "utf8",
);
const hyperion =
  "5abca81bb3d11673df57a855dc625d4d5a36bab44c5ba254830c50499a133617";

function createBrowser(initial = {}) {
  class Storage {
    getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; }
    setItem(key, value) { this[key] = String(value); }
    removeItem(key) { delete this[key]; }
  }
  const storage = new Storage();
  for (const [key, value] of Object.entries(initial)) storage.setItem(key, value);
  const callbacks = {};
  const requests = [];
  const downloads = [];
  const objectUrls = new Map();
  const reloads = { count: 0 };
  let nextObjectUrl = 0;
  let failNext = false;
  let lookupEntry = null;
  let confirmationResult = true;
  let confirmationCount = 0;
  let deferredDelete = null;
  let nextDeleteResponse = null;
  let fpsHotkeyReady = false;
  let fpsCounterElement = null;
  const fpsUiElements = [];
  const mutationObservers = [];

  function createElement(tagName) {
    const listeners = {};
    const captureListeners = {};
    const classes = new Set();
    return {
      tagName,
      children: [],
      listeners,
      captureListeners,
      attributes: {},
      style: {},
      nodeType: 1,
      classList: {
        add(...values) { for (const value of values) classes.add(value); },
        remove(...values) { for (const value of values) classes.delete(value); },
        contains(value) { return classes.has(value); },
      },
      appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        return child;
      },
      insertBefore(child, referenceChild) {
        const index = this.children.indexOf(referenceChild);
        if (index < 0) return this.appendChild(child);
        this.children.splice(index, 0, child);
        child.parentElement = this;
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentElement = null;
        return child;
      },
      matches(selector) {
        if (selector.includes(", ")) {
          return selector.split(", ").some((part) => this.matches(part));
        }
        if (selector === "select") return this.tagName === "select";
        if (selector === "button") return this.tagName === "button";
        if (selector === ".button.only-verified") {
          return classes.has("button") && classes.has("only-verified");
        }
        if (selector.startsWith(".")) return classes.has(selector.slice(1));
        if (selector === "span") return this.tagName === "span";
        if (selector === "button.main" ||
            selector === "button.main[data-polytrack-user-id]") {
          return this.tagName === "button" && classes.has("main") &&
            (selector === "button.main" ||
              Object.hasOwn(this.attributes, "data-polytrack-user-id"));
        }
        return false;
      },
      querySelectorAll(selector) {
        const found = [];
        const visit = (parent) => {
          for (const child of parent.children || []) {
            if (child.matches(selector)) found.push(child);
            visit(child);
          }
        };
        visit(this);
        return found;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      get firstChild() { return this.children[0] || null; },
      addEventListener(name, callback, options) {
        if (options === true) captureListeners[name] = callback;
        else listeners[name] = callback;
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      remove() { this.parentElement?.removeChild(this); },
      focus() { this.focused = true; },
      click() {
        const event = {
          target: this,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopImmediatePropagation() { this.propagationStopped = true; },
        };
        const result = captureListeners.click?.(event);
        if (!event.propagationStopped) listeners.click?.(event);
        if (tagName === "a" && this.download) {
          downloads.push({ filename: this.download, href: this.href });
        }
        return result;
      },
    };
  }

  function findElement(root, id) {
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const found = findElement(child, id);
      if (found) return found;
    }
    return null;
  }

  function createFpsCounterElement() {
    const properties = new Map();
    return {
      className: "debug-ui",
      style: {
        setProperty(name, value) { properties.set(name, value); },
        getPropertyValue(name) { return properties.get(name) || ""; },
      },
      getBoundingClientRect() {
        const width = 64;
        const height = 18;
        const left = 8;
        const top = Number.parseFloat(properties.get("--polytrack-fps-top") || "8");
        const right = left + width;
        return { left, right, top, bottom: top + height, width, height };
      },
    };
  }

  const body = createElement("body");
  const head = createElement("head");
  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    Storage,
    localStorage: storage,
    MutationObserver: undefined,
    getComputedStyle(element) {
      return element.computedStyle || {
        display: "block",
        visibility: "visible",
        opacity: "1",
      };
    },
    addEventListener(name, callback) { callbacks[name] = callback; },
  };
  class MockMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.active = true;
        mutationObservers.push(this);
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
      }
      disconnect() { this.active = false; }
  }
  const enableFpsMutationObserver = () => {
    window.MutationObserver = MockMutationObserver;
  };

  Object.assign(window, {
    Worker: class {
      constructor(url) { this.url = url; }
      addEventListener(name, callback) {
        this.listeners ??= {};
        this.listeners[name] ??= [];
        this.listeners[name].push(callback);
      }
      postMessage(message) {
        this.lastMessage = message;
        this.messages = [...(this.messages || []), message];
      }
      emitMessage(data) {
        for (const callback of this.listeners?.message || []) callback({ data });
      }
      terminate() {}
    },
    WebSocket: class {
      constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
      }
    },
    KeyboardEvent: class {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
      }
    },
    XMLHttpRequest: class {
      static DONE = 4;
      addEventListener(name, callback) { this.listeners ??= {}; this.listeners[name] = callback; }
      open(method, url) { this.method = method; this.url = url; }
      complete(response) {
        this.readyState = 4;
        this.status = 200;
        this.responseText = JSON.stringify(response);
        this.listeners?.readystatechange?.();
      }
    },
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options?.type || "";
      }
    },
    URL: {
      createObjectURL(blob) {
        const url = `blob:polytrack-test-${++nextObjectUrl}`;
        objectUrls.set(url, blob);
        return url;
      },
      revokeObjectURL(url) { objectUrls.delete(url); },
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    confirm() {
      confirmationCount += 1;
      return confirmationResult;
    },
    location: {
      protocol: "https:",
      host: "polytrack.example",
      href: "https://polytrack.example/",
      reload() { reloads.count += 1; },
    },
  });
  const document = {
    head,
    body,
    createElement,
    readyState: "loading",
    querySelector(selector) {
      if (selector === "#ui") return body;
      if (selector === ".menu-ui .main-buttons-container") {
        return body.querySelector(".main-buttons-container");
      }
      return selector === "#ui > .debug-ui" ? fpsCounterElement : null;
    },
    querySelectorAll(selector) {
      return selector === "#ui *"
        ? fpsUiElements
        : [];
    },
    getElementById(id) { return findElement(body, id); },
    addEventListener(name, callback) {
      documentListeners[name] ??= [];
      documentListeners[name].push(callback);
    },
    dispatchEvent(event) {
      dispatchedDocumentEvents.push(event);
      for (const callback of documentListeners[event.type] || []) callback(event);
      if (event.type === "keydown" && event.key === "=" && fpsHotkeyReady) {
        fpsCounterElement = createFpsCounterElement();
      }
      return true;
    },
  };
  const documentListeners = {};
  const dispatchedDocumentEvents = [];
  const timers = [];
  const intervals = [];
  const animationFrames = [];
  vm.runInNewContext(source, {
    window, document, crypto: webcrypto, TextEncoder, URLSearchParams,
    AbortController,
    console,
    setTimeout(callback, delay) {
      const timer = (...args) => {
        if (timer.cleared) return;
        timer.cleared = true;
        callback(...args);
      };
      timer.delay = delay;
      timer.cleared = false;
      timers.push(timer);
      return timer;
    },
    setInterval(callback) { intervals.push(callback); },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    async fetch(url, options) {
      if (String(url).includes("/api/v6/trackOfTheWeek")) {
        return {
          ok: true,
          json: async () => ({
            serverTime: "2026-10-05T12:00:00.000Z",
            current: {
              trackId: "a".repeat(64),
              name: "Alpha",
              thumbnailUrl: "/main/tracks/community/thumbnails/alpha.png",
            },
          }),
        };
      }
      const method = options?.method?.toUpperCase() || "GET";
      if (!options || method === "GET") {
        requests.push({ url, method: "GET" });
        return { ok: true, json: async () => lookupEntry };
      }
      const form = new URLSearchParams(options.body);
      requests.push({ url, form, method });
      if (failNext) {
        failNext = false;
        return { ok: false, status: 503 };
      }
      if (method === "DELETE") {
        if (deferredDelete) {
          const pending = deferredDelete;
          deferredDelete = null;
          pending.resolveRequest();
          return pending.response;
        }
        if (nextDeleteResponse) {
          const response = nextDeleteResponse;
          nextDeleteResponse = null;
          return response;
        }
        return { ok: true, json: async () => ({ deletedRecords: 1 }) };
      }
      if (url === "/api/v6/leaderboardNickname") {
        const result = { updatedRecords: 2 };
        return {
          ok: true,
          json: async () => result,
          text: async () => JSON.stringify(result),
        };
      }
      return { ok: true, text: async () => JSON.stringify({ uploadId: requests.length }) };
    },
  });
  callbacks.load();
  async function runSync(callback) {
    callback();
    // The sync is asynchronous (WebCrypto digest + fetch).
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return { window, document, callbacks, storage, requests, timers, intervals, animationFrames,
    dispatchedDocumentEvents, reloads, downloads, objectUrls, runSync,
    setFpsHotkeyReady(value) { fpsHotkeyReady = value; },
    enableFpsMutationObserver,
    setFpsUiElements(elements) {
      fpsUiElements.splice(0, fpsUiElements.length, ...elements);
    },
    mutationObservers,
    notifyDomMutation() {
      for (const observer of mutationObservers) {
        if (observer.active) {
          observer.callback([{ type: "childList", target: body }], observer);
        }
      }
    },
    flushAnimationFrames() {
      let passes = 0;
      while (animationFrames.length && passes < 20) {
        animationFrames.shift()();
        passes += 1;
      }
    },
    fail() { failNext = true; },
    setConfirm(value) { confirmationResult = value; },
    setNextDeleteResponse(response) { nextDeleteResponse = response; },
    get confirmationCount() { return confirmationCount; },
    setLookup(entry) { lookupEntry = entry; },
    deferNextDelete() {
      let resolveResponse;
      let resolveRequest;
      const response = new Promise((resolve) => { resolveResponse = resolve; });
      const requested = new Promise((resolve) => { resolveRequest = resolve; });
      deferredDelete = { response, resolveRequest };
      return {
        requested,
        complete() {
          resolveResponse({
            ok: true,
            json: async () => ({ deletedRecords: 1 }),
          });
        },
      };
    } };
}

function createLeaderboardView(document, rows, totalPlayers, personalBestValues) {
  const leaderboard = document.createElement("section");
  const container = document.createElement("div");
  container.classList.add("container");
  const rowElements = [];
  for (const { name, userId } of rows) {
    const row = document.createElement("button");
    row.classList.add("main");
    row.textContent = name;
    if (userId) row.setAttribute("data-polytrack-user-id", userId);
    container.appendChild(row);
    rowElements.push(row);
  }
  leaderboard.appendChild(container);

  const count = document.createElement("div");
  count.classList.add("total-players");
  count.textContent = `${totalPlayers} players`;
  leaderboard.appendChild(count);

  const personalBest = document.createElement("div");
  for (const value of personalBestValues) {
    const span = document.createElement("span");
    span.textContent = value;
    personalBest.appendChild(span);
  }
  return { leaderboard, container, count, personalBest, rows: rowElements };
}

test("profile backups export player, paint, settings, and legacy PolyTrack data", () => {
  const recordKey = `polytrack_v5_prod_record_1_default_${hyperion}`;
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "1",
    "polytrack_v5_prod_user_1": JSON.stringify({
      token: "private-profile-token",
      nickname: "Fast Driver",
      carStyle: "default",
    }),
    "polytrack_v5_prod_settings": JSON.stringify([["paint", "#45a6ff"]]),
    "polytrack_v5_prod_key_bindings": JSON.stringify([["throttle", "ArrowUp"]]),
    [recordKey]: JSON.stringify({
      frames: 120,
      recording: "saved-control-stream",
      replayBoostSettings: { accelerationMultiplier: 1.5 },
    }),
    "car_colors": JSON.stringify(["#112233", "#445566"]),
    "v1_car": JSON.stringify(["legacy-car", 1]),
    "v2_settings": JSON.stringify([["camera", "follow"]]),
    "unrelated_site_data": "must not leave this origin",
  });

  const backup = browser.window.__polytrackBuildProfileBackupPayload();
  const entries = new Map(backup.entries);
  assert.equal(backup.format, "polytrack-profile-backup");
  assert.equal(backup.version, 1);
  assert.equal(entries.get("polytrack_v5_prod_user_1"),
    browser.storage.getItem("polytrack_v5_prod_user_1"));
  assert.equal(entries.get("polytrack_v5_prod_settings"),
    browser.storage.getItem("polytrack_v5_prod_settings"));
  assert.equal(entries.get(recordKey), browser.storage.getItem(recordKey));
  assert.equal(entries.get("car_colors"), browser.storage.getItem("car_colors"));
  assert.equal(entries.get("v1_car"), browser.storage.getItem("v1_car"));
  assert.equal(entries.get("v2_settings"), browser.storage.getItem("v2_settings"));
  assert.equal(entries.has("unrelated_site_data"), false);
});

test("profile backup download creates a JSON file with the saved profile", () => {
  const browser = createBrowser({
    "polytrack_v5_prod_user_0": JSON.stringify({
      token: "downloaded-profile-token",
      nickname: "Saved Driver",
      carStyle: "default",
    }),
  });
  browser.window.__polytrackOpenProfileBackup();
  browser.document.getElementById("polytrack-profile-export").click();

  assert.equal(browser.downloads.length, 1);
  const [download] = browser.downloads;
  assert.match(download.filename, /^polytrack-profile-\d{4}-\d{2}-\d{2}\.json$/);
  const blob = browser.objectUrls.get(download.href);
  assert.equal(blob.type, "application/json");
  const file = JSON.parse(blob.parts.join(""));
  assert.equal(file.format, "polytrack-profile-backup");
  assert.ok(file.entries.some(([key, value]) =>
    key === "polytrack_v5_prod_user_0" &&
    JSON.parse(value).nickname === "Saved Driver"));
});

test("profile backup restores saved data on a new browser after confirmation", async () => {
  const recordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const original = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token: "transferable-profile-token",
      nickname: "Poly Driver",
      carStyle: "default",
    }),
    "polytrack_v5_prod_settings": JSON.stringify([["paint", "#7cfc00"]]),
    "car_colors": JSON.stringify(["#7cfc00", "#ffffff"]),
    [recordKey]: JSON.stringify({
      tokenHash: "a".repeat(64),
      frames: 150,
      recording: "personal-best-replay",
    }),
  });
  const payload = original.window.__polytrackBuildProfileBackupPayload();
  const fileContents = JSON.stringify(payload);
  const browser = createBrowser({
    "polytrack_v5_prod_settings": "old-local-settings",
    "unrelated_site_data": "keep",
  });
  const mainButtons = browser.document.createElement("div");
  mainButtons.classList.add("main-buttons-container");
  browser.document.body.appendChild(mainButtons);
  assert.equal(browser.window.__polytrackInstallProfileBackupButton(), true);

  const backupButton = browser.document.getElementById("polytrack-profile-backup-button");
  assert.ok(backupButton);
  backupButton.click();
  const importButton = browser.document.getElementById("polytrack-profile-import");
  const fileInput = browser.document.getElementById("polytrack-profile-backup-file");
  importButton.click();
  fileInput.files = [{
    size: fileContents.length,
    text: async () => fileContents,
  }];
  await fileInput.listeners.change({ target: fileInput });

  assert.equal(browser.confirmationCount, 1);
  assert.equal(browser.storage.getItem("polytrack_v5_prod_user_0"),
    original.storage.getItem("polytrack_v5_prod_user_0"));
  assert.equal(browser.storage.getItem("polytrack_v5_prod_settings"),
    original.storage.getItem("polytrack_v5_prod_settings"));
  assert.equal(browser.storage.getItem("car_colors"),
    original.storage.getItem("car_colors"));
  assert.equal(browser.storage.getItem(recordKey), original.storage.getItem(recordKey));
  assert.equal(browser.storage.getItem("unrelated_site_data"), "keep");
  assert.match(
    browser.document.getElementById("polytrack-profile-backup-status").textContent,
    /Restored .* personal best.* Reloading PolyTrack/,
  );
  const reloadTimer = browser.timers.at(-1);
  assert.equal(reloadTimer.delay, 500);
  reloadTimer();
  assert.equal(browser.reloads.count, 1);
});

test("declining a profile backup replacement leaves browser data untouched", async () => {
  const original = createBrowser({
    "polytrack_v5_prod_user_0": JSON.stringify({
      token: "portable-token",
      nickname: "Driver",
      carStyle: "default",
    }),
  });
  const payload = original.window.__polytrackBuildProfileBackupPayload();
  const fileContents = JSON.stringify(payload);
  const browser = createBrowser({
    "polytrack_v5_prod_settings": "keep-this-settings-value",
  });
  browser.setConfirm(false);
  browser.window.__polytrackOpenProfileBackup();
  const fileInput = browser.document.getElementById("polytrack-profile-backup-file");
  fileInput.files = [{
    size: fileContents.length,
    text: async () => fileContents,
  }];
  await fileInput.listeners.change({ target: fileInput });

  assert.equal(browser.confirmationCount, 1);
  assert.equal(browser.storage.getItem("polytrack_v5_prod_settings"),
    "keep-this-settings-value");
  assert.equal(browser.storage.getItem("polytrack_v5_prod_user_0"), null);
  assert.equal(browser.reloads.count, 0);
  assert.match(
    browser.document.getElementById("polytrack-profile-backup-status").textContent,
    /Import cancelled/,
  );
});

test("invalid profile backup files cannot overwrite browser data", async () => {
  const browser = createBrowser({
    "polytrack_v5_prod_settings": "keep-this-settings-value",
  });
  browser.window.__polytrackOpenProfileBackup();
  const fileInput = browser.document.getElementById("polytrack-profile-backup-file");
  const fileContents = JSON.stringify({
    format: "polytrack-profile-backup",
    version: 1,
    entries: [["unrelated_site_data", "injected"]],
  });
  fileInput.files = [{
    size: fileContents.length,
    text: async () => fileContents,
  }];
  await fileInput.listeners.change({ target: fileInput });

  assert.equal(browser.confirmationCount, 0);
  assert.equal(browser.storage.getItem("polytrack_v5_prod_settings"),
    "keep-this-settings-value");
  assert.equal(browser.storage.getItem("unrelated_site_data"), null);
  assert.equal(browser.reloads.count, 0);
  assert.match(
    browser.document.getElementById("polytrack-profile-backup-status").textContent,
    /invalid or duplicate saved item/,
  );
});

test("public leaderboards do not reveal or filter replay boost status", () => {
  const legacyFilterKey = "polytrack_leaderboard_boost_filter_v1";
  const userIds = ["a", "b", "c"].map((letter) => letter.repeat(64));
  const browser = createBrowser({ [legacyFilterKey]: "boosted" });
  const view = createLeaderboardView(
    browser.document,
    [
      { name: "Boosted driver" },
      { name: "Normal driver" },
      { name: "Legacy driver" },
    ],
    3,
    [],
  );
  browser.document.querySelector = (selector) => {
    if (selector === ".track-info-ui .leaderboard-ui") return view.leaderboard;
    return null;
  };

  const xhr = new browser.window.XMLHttpRequest();
  const url = `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20`;
  xhr.open("GET", url);
  assert.equal(xhr.url, url,
    "a previously saved public filter is not added to leaderboard requests");
  xhr.complete({
    entries: [
      { userId: userIds[0], replayBoostStatus: "boosted" },
      { userId: userIds[1], replayBoostStatus: "not-boosted" },
      { userId: userIds[2], replayBoostStatus: "unknown" },
    ],
  });
  const taggingTimer = browser.timers.at(-1);
  assert.equal(taggingTimer.delay, 0);
  taggingTimer();

  assert.equal(view.leaderboard.querySelector(".polytrack-boost-filter"), null,
    "there is no public replay-status filter");
  assert.deepEqual(
    view.rows.map((row) => row.querySelector(".polytrack-boost-status")?.textContent),
    [undefined, undefined, undefined],
    "leaderboard rows never display replay boost labels",
  );
  assert.deepEqual(
    view.rows.map((row) => row.getAttribute("data-polytrack-boost-status")),
    [null, null, null],
    "replay classifications are not attached to public rows",
  );
  assert.deepEqual(
    view.rows.map((row) => row.getAttribute("data-polytrack-user-id")),
    userIds,
    "private-record deletion can still identify the current player row",
  );
});

test("PB deletion uses the live game profile and waits for native writes before reading records", async () => {
  const token = "live-beta-profile";
  const tokenHash = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
  const recordKey = `polytrack_v5_beta_record2_1_default_${hyperion}`;
  const legacyKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const browser = createBrowser({
    "polytrack_v5_prod_user_0": JSON.stringify({ token: "legacy-profile", nickname: "Legacy" }),
    [legacyKey]: JSON.stringify({ tokenHash: "a".repeat(64), frames: 100, recording: "legacy" }),
  });
  browser.window.__polytrackGetActiveProfile = () => ({
    key: "polytrack_v5_beta_user_1",
    profile: { token, nickname: "Live player", carStyle: "default" },
  });
  let finishWrite;
  const pendingWrite = new Promise(resolve => { finishWrite = resolve; });
  browser.window.__polytrackWaitForRecordWrites = async (trackId) => {
    assert.equal(trackId, hyperion);
    await pendingWrite;
    browser.storage.setItem(recordKey, JSON.stringify({ tokenHash, frames: 123, recording: "native-synced" }));
  };
  const deletion = browser.window.__polytrackDeleteOwnPbForTrack(hyperion);
  await Promise.resolve();
  assert.equal(browser.requests.filter(request => request.method === "DELETE").length, 0);
  finishWrite();
  await deletion;
  const request = browser.requests.find(request => request.method === "DELETE");
  assert.ok(request);
  assert.equal(request.form.get("userToken"), token, "does not select a leftover profile namespace");
  assert.equal(browser.storage.getItem(recordKey), null, "also deletes a PB restored by the pending native sync");
  assert.ok(browser.storage.getItem(legacyKey), "unrelated profile data is preserved");
});

test("the built-in FPS counter starts at the top-left and keeps its native toggle", () => {
  const browser = createBrowser();
  assert.equal(browser.document.getElementById("polytrack-fps-counter"), null);
  const css = browser.document.head.children.find((element) =>
    element.tagName === "style",
  )?.textContent;
  assert.match(css, /#ui > \.debug-ui\s*\{[^}]*position:\s*fixed !important;[^}]*top:\s*8px !important;[^}]*left:\s*8px !important;[^}]*bottom:\s*auto !important;[^}]*right:\s*auto !important;[^}]*translate:\s*0 calc\(var\(--polytrack-fps-top,\s*8px\)\s*-\s*8px\) !important;/s);
  assert.match(css, /transition:\s*translate 150ms ease-out/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*transition-duration:\s*0s !important/);
  assert.doesNotMatch(css, /#polytrack-fps-counter/);
  assert.equal(browser.animationFrames.length, 0);

  browser.document.dispatchEvent({ type: "DOMContentLoaded" });
  const eventCount = browser.dispatchedDocumentEvents.length;
  const startupTimer = browser.timers.at(-1);
  assert.equal(startupTimer.delay, 0);
  startupTimer();
  assert.deepEqual(
    browser.dispatchedDocumentEvents.slice(eventCount).map(({ type, key, code }) => ({
      type, key, code,
    })),
    [
      { type: "keydown", key: "=", code: "Equal" },
      { type: "keyup", key: "=", code: "Equal" },
    ],
  );
  const retryTimer = browser.timers.at(-1);
  assert.equal(retryTimer.delay, 500);

  browser.setFpsHotkeyReady(true);
  const eventCountBeforeRetry = browser.dispatchedDocumentEvents.length;
  const timerCountBeforeRetry = browser.timers.length;
  retryTimer();
  assert.ok(browser.document.querySelector("#ui > .debug-ui"));
  assert.deepEqual(
    browser.dispatchedDocumentEvents.slice(eventCountBeforeRetry).map(({ type }) => type),
    ["keydown", "keyup"],
  );
  assert.equal(browser.timers.length, timerCountBeforeRetry);
});

test("the FPS counter clears overlapping top-left game UI and returns when it clears", () => {
  const browser = createBrowser();
  const button = (rect, hidden = false) => ({
    rectReads: 0,
    hidden,
    computedStyle: {
      display: hidden ? "none" : "block",
      visibility: "visible",
      opacity: "1",
    },
    getAttribute() { return null; },
    getBoundingClientRect() { this.rectReads += 1; return rect; },
  });

  browser.enableFpsMutationObserver();
  browser.setFpsHotkeyReady(true);
  browser.document.dispatchEvent({ type: "DOMContentLoaded" });
  browser.timers.at(-1)();
  browser.flushAnimationFrames();
  const counter = browser.document.querySelector("#ui > .debug-ui");
  assert.ok(counter);
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "8px");
  const positionObserver = browser.mutationObservers.find((observer) =>
    observer.options?.attributeFilter?.includes("aria-expanded")
  );
  assert.ok(positionObserver, "the FPS position observer is installed");
  assert.equal(positionObserver.target, browser.document.querySelector("#ui"));
  assert.ok(!positionObserver.options.attributeFilter.includes("style"));
  assert.equal(positionObserver.options.attributeOldValue, true);
  assert.equal(positionObserver.options.characterData, undefined);
  const hud = browser.document.createElement("span");
  for (let frame = 0; frame < 120; frame += 1) {
    positionObserver.callback([{
      type: "childList",
      target: hud,
      addedNodes: [{ nodeType: 3, textContent: String(frame) }],
      removedNodes: [{ nodeType: 3 }],
    }]);
  }
  assert.equal(browser.animationFrames.length, 0,
    "changing gameplay HUD text does not schedule FPS layout scans");
  const gameControl = {
    getAttribute() { return "arrow-up"; },
  };
  for (let frame = 0; frame < 120; frame += 1) {
    positionObserver.callback([{
      type: "attributes",
      target: gameControl,
      attributeName: "class",
      oldValue: "arrow-up",
    }]);
  }
  assert.equal(browser.animationFrames.length, 0,
    "repeated no-op control class writes do not schedule FPS layout scans");
  gameControl.getAttribute = () => "active arrow-up";
  positionObserver.callback([{
    type: "attributes",
    target: gameControl,
    attributeName: "class",
    oldValue: "arrow-up",
  }]);
  assert.equal(browser.animationFrames.length, 1,
    "a real control class change still schedules a layout update");
  browser.flushAnimationFrames();
  positionObserver.callback([{
    type: "childList",
    target: hud,
    addedNodes: [browser.document.createElement("button")],
    removedNodes: [],
  }]);
  assert.equal(browser.animationFrames.length, 1,
    "adding an actual control still repositions FPS");
  browser.flushAnimationFrames();

  const farRightButton = button({
    left: 800, right: 1020, top: 0, bottom: 40, width: 220, height: 40,
  });
  browser.setFpsUiElements([farRightButton]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "8px");

  const topLeftButton = button({
    left: 0, right: 80, top: 0, bottom: 42, width: 80, height: 42,
  });
  browser.setFpsUiElements([farRightButton, topLeftButton]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "62px");

  const resultText = {
    hidden: false,
    computedStyle: {
      display: "block",
      visibility: "visible",
      opacity: "1",
    },
    getAttribute() { return null; },
    getBoundingClientRect() {
      return { left: 12, right: 132, top: 56, bottom: 88, width: 120, height: 32 };
    },
  };
  browser.setFpsUiElements([topLeftButton, resultText]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "108px");

  const recordText = {
    ...resultText,
    getBoundingClientRect() {
      return { left: 12, right: 92, top: 84, bottom: 98, width: 80, height: 14 };
    },
  };
  browser.setFpsUiElements([topLeftButton, resultText, recordText]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "118px");

  const lowerButton = button({
    left: 24, right: 68, top: 104, bottom: 126, width: 44, height: 22,
  });
  const previousButtonReads = topLeftButton.rectReads;
  browser.setFpsUiElements([topLeftButton, resultText, recordText, lowerButton]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "146px");
  assert.equal(topLeftButton.rectReads - previousButtonReads, 1,
    "collision chains measure each control only once per update");
  assert.equal(lowerButton.rectReads, 1);

  const fadingPanel = {
    computedStyle: {
      display: "block",
      visibility: "visible",
      opacity: "0",
    },
  };
  const fadingText = { ...resultText, parentElement: fadingPanel };
  browser.setFpsUiElements([fadingText]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "8px");

  browser.setFpsUiElements([]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "8px");

  const mapRows = Array.from({ length: 16 }, (_, index) => {
    const top = index * 50;
    return button({
      left: 0, right: 80, top, bottom: top + 40, width: 80, height: 40,
    });
  });
  browser.setFpsUiElements(mapRows);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "160px");
  assert.ok(
    160 + 18 <= browser.window.innerHeight,
    "the counter stays within the bottom of the viewport",
  );

  browser.window.innerHeight = 120;
  browser.setFpsUiElements(mapRows);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "94px");
  assert.ok(94 + 18 <= browser.window.innerHeight - 8);

  browser.window.innerHeight = 768;
  browser.setFpsUiElements([]);
  browser.notifyDomMutation();
  browser.flushAnimationFrames();
  assert.equal(counter.style.getPropertyValue("--polytrack-fps-top"), "8px");
});

test("returning browsers fetch a fresh site-features script", () => {
  const html = readFileSync(
    require("node:path").join(__dirname, "../index.html"),
    "utf8",
  );
  assert.match(html, /<script[^>]+src="\/site-features\.js\?v=[^"]+"/);
  assert.match(html, /http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/);
  assert.match(html, /http-equiv="Pragma" content="no-cache"/);
});

test("weekly community map is stable during the week and changes on Monday UTC", () => {
  const { window } = createBrowser();
  const tracks = [
    { id: "a".repeat(64), name: "Alpha" },
    { id: "b".repeat(64), name: "Bravo" },
    { id: "c".repeat(64), name: "Charlie" },
    { id: "d".repeat(64), name: "Delta" },
  ];
  const select = window.__polytrackSelectWeeklyTrack;
  const sunday = select(tracks, new Date("2026-10-04T23:59:59.000Z"));
  const sameWeek = select([...tracks].reverse(), new Date("2026-10-04T12:00:00.000Z"));
  assert.equal(sunday.id, sameWeek.id, "map ordering and same-week reloads do not change the pick");
  assert.equal(sunday.weekStart, "2026-09-28");

  let previousId = sunday.id;
  for (let week = 1; week <= 12; week += 1) {
    const monday = new Date(Date.UTC(2026, 8, 28 + week * 7));
    const selected = select(tracks, monday);
    assert.notEqual(selected.id, previousId, "each Monday advances to a different map");
    previousId = selected.id;
  }
  assert.equal(select([], new Date("2026-10-05T00:00:00.000Z")), null);
});

test("an anonymous profile gets the first-join name prompt and saves its name", async () => {
  const otherProfileKey = "polytrack_v5_prod_user_0";
  const activeProfileKey = "polytrack_v5_prod_user_1";
  const { document, storage, requests, timers, reloads } = createBrowser({
    "polytrack_v5_prod_user_slot": "1",
    [otherProfileKey]: JSON.stringify({
      token: "other-profile-token", nickname: "Known Driver", carStyle: "default",
    }),
    [activeProfileKey]: JSON.stringify({
      token: "active-profile-token", nickname: "aNoNyMoUs", carStyle: "default",
    }),
  });

  assert.equal(document.getElementById("polytrack-profile-name-launcher"), null);
  assert.ok(document.getElementById("polytrack-name-backdrop"));
  const input = document.getElementById("polytrack-name-input");
  assert.equal(input.focused, true);
  assert.equal(
    document.getElementById("polytrack-name-title").textContent,
    "Choose your leaderboard name",
  );
  const submit = document.getElementById("polytrack-name-form").listeners.submit;
  input.value = " Anonymous ";
  await submit({ preventDefault() {} });
  assert.match(
    document.getElementById("polytrack-name-status").textContent,
    /other than Anonymous/,
  );
  assert.equal(requests.length, 0, "the default name is not sent to the leaderboard");

  input.value = "  Fast Driver  ";
  await submit({ preventDefault() {} });

  const update = requests.find((request) => request.url === "/api/v6/leaderboardNickname");
  assert.ok(update);
  assert.equal(update.form.get("userToken"), "active-profile-token");
  assert.equal(update.form.get("nickname"), "Fast Driver");
  assert.equal(JSON.parse(storage.getItem(activeProfileKey)).nickname, "Fast Driver");
  assert.equal(
    JSON.parse(storage.getItem(otherProfileKey)).nickname,
    "Known Driver",
    "saving the active profile leaves other profiles unchanged",
  );
  assert.equal(
    storage.getItem("polytrack_leaderboard_nickname_pending_v1"),
    null,
    "the pending update is cleared after historical records are updated",
  );
  assert.match(document.getElementById("polytrack-name-status").textContent, /Name saved/);
  timers.find((timer) => timer.delay === 700)();
  assert.equal(reloads.count, 1, "the game reloads to apply the initial profile name");
});

test("named players make later name changes in Garage without another name dialog", async () => {
  const profileKey = "polytrack_v5_prod_user_0";
  const { window, document, storage, requests, reloads } = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    [profileKey]: JSON.stringify({
      token: "named-profile-token", nickname: "Existing Driver", carStyle: "default",
    }),
  });

  assert.equal(document.getElementById("polytrack-profile-name-launcher"), null);
  assert.equal(document.getElementById("polytrack-name-backdrop"), null);
  const profile = JSON.parse(storage.getItem(profileKey));
  profile.nickname = "New Driver";
  storage.setItem(profileKey, JSON.stringify(profile));
  await window.__polytrackProfileNicknameSaved(profile.token, profile.nickname);

  const update = requests.find((request) => request.url === "/api/v6/leaderboardNickname");
  assert.ok(update);
  assert.equal(update.form.get("userToken"), "named-profile-token");
  assert.equal(update.form.get("nickname"), "New Driver");
  assert.equal(reloads.count, 0, "the native profile save applies without a reload");
});

test("Garage leaderboard nickname updates retry automatically after a network failure", async () => {
  const profileKey = "polytrack_v5_prod_user_0";
  const { window, storage, requests, intervals, runSync, fail } = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    [profileKey]: JSON.stringify({
      token: "named-profile-token", nickname: "Existing Driver", carStyle: "default",
    }),
  });
  const profile = JSON.parse(storage.getItem(profileKey));
  profile.nickname = "New Driver";
  storage.setItem(profileKey, JSON.stringify(profile));

  fail();
  const firstAttempt = window.__polytrackProfileNicknameSaved(
    profile.token,
    profile.nickname,
  );
  await firstAttempt;
  assert.ok(storage.getItem("polytrack_leaderboard_nickname_pending_v1"));

  assert.equal(
    requests.filter((request) =>
      request.url === "/api/v6/leaderboardNickname").length,
    1,
    "the failed first attempt leaves a pending update",
  );
  const retry = intervals[0];
  await runSync(retry);
  const updates = requests.filter((request) =>
    request.url === "/api/v6/leaderboardNickname");
  assert.equal(updates.length, 2);
  assert.equal(updates[1].form.get("nickname"), "New Driver");
  assert.equal(storage.getItem("polytrack_leaderboard_nickname_pending_v1"), null);
});

test("refreshing returns active cheat settings to normal but preserves saved replay boosts", () => {
  const cheatSettingsKey = "polytrack_cheat_settings_v1";
  const recordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const savedReplaySettings = {
    accelerationMultiplier: 1.8,
    brakingMultiplier: 1.2,
    topSpeedMultiplier: 1.4,
  };
  const first = createBrowser({
    [cheatSettingsKey]: JSON.stringify({
      accelerationMultiplier: 2,
      brakingMultiplier: 1.7,
      topSpeedMultiplier: 1.9,
    }),
    [recordKey]: JSON.stringify({
      uploadId: null, tokenHash: "a".repeat(64), frames: 100,
      recording: "saved-boosted-controls",
      replayBoostSettings: savedReplaySettings,
    }),
  });
  assert.deepEqual(
    { ...first.window.__polytrackCheatSettings },
    { accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1 },
  );
  assert.equal(first.window.__polytrackCheatUnlocked, false);
  assert.equal(first.storage.getItem(cheatSettingsKey), null,
    "legacy saved sliders are cleared on page load");

  for (const key of "jinitaimei114") {
    first.callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const acceleration = first.document.getElementById("polytrack-cheat-accelerationMultiplier");
  acceleration.value = "1.6";
  acceleration.listeners.input({ target: acceleration });

  const reloadedStorage = Object.fromEntries(
    Object.keys(first.storage).map((key) => [key, first.storage.getItem(key)]),
  );
  const refreshed = createBrowser(reloadedStorage);
  assert.deepEqual(
    { ...refreshed.window.__polytrackCheatSettings },
    { accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1 },
  );
  assert.equal(refreshed.window.__polytrackCheatUnlocked, false);
  assert.equal(refreshed.storage.getItem(cheatSettingsKey), null);

  refreshed.storage.getItem(recordKey);
  const replayWorker = new refreshed.window.Worker("simulation_worker.bundle.js");
  replayWorker.postMessage({
    messageType: 3, carId: 2, carRecording: "saved-boosted-controls",
  });
  assert.deepEqual(
    { ...replayWorker.lastMessage.replayBoostSettings },
    savedReplaySettings,
    "refreshing resets active sliders without erasing a saved PB's replay settings",
  );
});

test("typing the cheat enables a boost for only the player's car", () => {
  const { window, document, callbacks, storage, timers } = createBrowser();
  const worker = new window.Worker("simulation_worker.bundle.js");
  assert.equal(worker.url, "site-simulation-worker.js");
  worker.postMessage({ messageType: 3, carId: 2, carRecording: "ghost-run" });
  worker.postMessage({ messageType: 3, carId: 1, carRecording: null });
  worker.postMessage({ messageType: 6, carId: 1, up: true });
  assert.equal(worker.lastMessage.accelerationBoost, false);
  for (const key of "wolaitongniwan") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  assert.equal(window.__polytrackCheatUnlocked, false, "the previous phrase no longer unlocks");
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  assert.equal(window.__polytrackAccelerationBoost, false,
    "unlocking the cheat starts at normal speed");
  assert.equal(window.__polytrackCheatUnlocked, true);
  assert.deepEqual(
    { ...window.__polytrackCheatSettings },
    { accelerationMultiplier: 1, topSpeedMultiplier: 1, brakingMultiplier: 1 },
  );
  assert.equal(document.getElementById("polytrack-cheat-title").textContent, "我来同你玩！");
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, false);
  const menuLauncher = document.getElementById("polytrack-cheat-launcher");
  assert.equal(menuLauncher.hidden, false);
  assert.equal(worker.lastMessage.accelerationMultiplier, 1);
  assert.equal(worker.lastMessage.topSpeedMultiplier, 1);
  assert.equal(worker.lastMessage.brakingMultiplier, 1);

  const acceleration = document.getElementById("polytrack-cheat-accelerationMultiplier");
  acceleration.value = "1.8";
  acceleration.listeners.input({ target: acceleration });
  assert.equal(window.__polytrackCheatSettings.accelerationMultiplier, 1.8);
  assert.equal(worker.lastMessage.accelerationMultiplier, 1.8, "live settings reach the player worker");
  assert.equal(worker.lastMessage.accelerationBoost, true);

  const speed = document.getElementById("polytrack-cheat-topSpeedMultiplier");
  speed.value = "1.7";
  speed.listeners.input({ target: speed });
  assert.equal(worker.lastMessage.topSpeedMultiplier, 1.7);
  const braking = document.getElementById("polytrack-cheat-brakingMultiplier");
  braking.value = "1.4";
  braking.listeners.input({ target: braking });
  assert.equal(worker.lastMessage.brakingMultiplier, 1.4);
  assert.equal(storage.getItem("polytrack_cheat_settings_v1"), null,
    "cheat settings are not persisted across reloads");
  document.getElementById("polytrack-cheat-reset").click();
  assert.deepEqual(
    { ...window.__polytrackCheatSettings },
    { accelerationMultiplier: 1, topSpeedMultiplier: 1, brakingMultiplier: 1 },
  );
  assert.equal(worker.lastMessage.topSpeedMultiplier, 1, "reset defaults apply immediately");

  worker.postMessage({ messageType: 6, carId: 1, up: true });
  assert.equal(worker.lastMessage.accelerationBoost, false);
  worker.postMessage({ messageType: 6, carId: 2, up: true });
  assert.equal(worker.lastMessage.accelerationBoost, false);
  assert.equal(worker.lastMessage.accelerationMultiplier, 1, "other cars receive neutral settings");
  assert.equal(worker.lastMessage.topSpeedMultiplier, 1);
  assert.equal(worker.lastMessage.brakingMultiplier, 1);

  const menuTimeouts = () => timers.filter((timer) => timer.delay === 10_000);
  const firstMenuTimeout = menuTimeouts()[0];
  assert.ok(firstMenuTimeout, "menu activation schedules a 10-second timeout");
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, false,
    "re-entering the code renews the active menu");
  assert.equal(firstMenuTimeout.cleared, true, "renewal cancels the previous timeout");
  const renewedMenuTimeout = menuTimeouts().at(-1);
  assert.notEqual(renewedMenuTimeout, firstMenuTimeout);
  firstMenuTimeout();
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, false,
    "a cancelled timeout cannot hide a renewed menu");
  renewedMenuTimeout();
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, true);
  assert.equal(menuLauncher.hidden, true, "launcher disappears with the menu");
  assert.equal(window.__polytrackCheatUnlocked, true, "menu timeout keeps active settings enabled");
  menuLauncher.click();
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, true,
    "the hidden launcher cannot reopen the menu");

  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, false);
  assert.equal(menuLauncher.hidden, false, "entering the code again reopens the menu");
  const secondMenuTimeout = menuTimeouts().at(-1);
  assert.notEqual(secondMenuTimeout, renewedMenuTimeout);
  secondMenuTimeout();
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, true,
    "the reactivated menu also disappears after 10 seconds");
  assert.equal(menuLauncher.hidden, true);

  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  document.getElementById("polytrack-cheat-close").click();
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, true);
  menuLauncher.click();
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, false);
  callbacks.keydown({ key: "Escape", target: {}, ctrlKey: false, metaKey: false, altKey: false });
  assert.equal(document.getElementById("polytrack-cheat-backdrop").hidden, true);
});

test("cheat menu clears replay status on Watch exits and track changes", () => {
  const { window, document, callbacks } = createBrowser();
  const worker = new window.Worker("simulation_worker.bundle.js");
  const watchClick = (button) => {
    const trackInfoButton = {
      textContent: button === "watch" ? "Watch" : "Play",
      querySelector(selector) {
        if (selector !== "img.button-icon") return null;
        const iconSource = button === "watch"
          ? "images/preview.svg"
          : "images/play.svg";
        return { getAttribute: (name) => name === "src" ? iconSource : null };
      },
    };
    document.dispatchEvent({
      type: "click",
      target: {
        closest(selector) {
          return selector === ".track-info-ui .button" ? trackInfoButton : null;
        },
      },
    });
  };
  const trackSelectionClick = () => document.dispatchEvent({
    type: "click",
    target: {
      closest(selector) {
        return selector === ".track-selection-ui .track > .button" ? this : null;
      },
    },
  });
  const toolbarTrackNavigationClick = (iconSource) => document.dispatchEvent({
    type: "click",
    target: {
      closest(selector) {
        return selector === ".game-toolbar-ui .button" ? this : null;
      },
      querySelector(selector) {
        if (selector !== "img.button-icon") return null;
        return {
          getAttribute(name) {
            return name === "src" ? iconSource : null;
          },
        };
      },
    },
  });

  worker.postMessage({
    messageType: 3,
    carId: 2,
    carRecording: "boosted-replay",
    replayBoostSettings: {
      accelerationMultiplier: 1.8,
      brakingMultiplier: 1,
      topSpeedMultiplier: 1.2,
    },
  });
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const status = document.getElementById("polytrack-cheat-replay-status");
  const exitWatch = () => {
    const exitButton = {
      querySelector(selector) {
        return selector === "img.button-icon"
          ? { getAttribute: (name) => name === "src" ? "images/quit.svg" : null }
          : null;
      },
    };
    document.dispatchEvent({
      type: "click",
      target: {
        closest(selector) {
          return selector === ".game-toolbar-ui .button" ? exitButton : null;
        },
      },
    });
  };
  const closeAndReopenMenu = () => {
    document.getElementById("polytrack-cheat-close").click();
    assert.equal(
      document.getElementById("polytrack-cheat-backdrop").hidden,
      true,
      "the cheat menu closes after leaving Watch",
    );
    document.getElementById("polytrack-cheat-launcher").click();
    assert.equal(
      document.getElementById("polytrack-cheat-backdrop").hidden,
      false,
      "the cheat menu can reopen without starting another replay",
    );
    assert.equal(
      status.hidden,
      true,
      "reopening the cheat menu does not restore the exited replay status",
    );
  };
  assert.equal(status.hidden, true, "a replay ghost alone does not imply replay viewing");

  watchClick("watch");
  assert.match(status.textContent, /checking replay data/i);
  worker.postMessage({
    messageType: 3,
    carId: 3,
    carRecording: "boosted-replay",
    replayBoostSettings: {
      accelerationMultiplier: 1.8,
      brakingMultiplier: 1,
      topSpeedMultiplier: 1.2,
    },
  });
  assert.match(status.textContent, /BOOSTED/);

  worker.postMessage({ messageType: 4, carId: 3 });
  assert.equal(status.hidden, true, "the status hides when the watched replay ends");

  watchClick("watch");
  worker.postMessage({
    messageType: 3,
    carId: 4,
    carRecording: "confirmed-normal-replay",
    normalPhysicsConfirmed: true,
  });
  assert.match(status.textContent, /NOT BOOSTED/);
  worker.postMessage({ messageType: 4, carId: 4 });
  assert.equal(status.hidden, true, "the status hides when the watched replay ends");

  watchClick("watch");
  worker.postMessage({
    messageType: 3,
    carId: 6,
    carRecording: "boosted-replay",
    replayBoostSettings: {
      accelerationMultiplier: 1.8,
      brakingMultiplier: 1,
      topSpeedMultiplier: 1.2,
    },
  });
  assert.match(status.textContent, /BOOSTED/);
  exitWatch();
  assert.equal(status.hidden, true, "exiting Watch hides a boosted replay status");
  closeAndReopenMenu();

  watchClick("watch");
  worker.postMessage({ messageType: 3, carId: 7, carRecording: "legacy-replay" });
  assert.match(status.textContent, /UNKNOWN/);
  assert.match(status.textContent, /no saved boost data/i);
  assert.equal(status.hidden, false, "the replay status is visible during Watch");

  watchClick("play");
  assert.equal(
    status.hidden,
    true,
    "switching to Play before the watched replay ends clears its status",
  );

  watchClick("watch");
  worker.postMessage({
    messageType: 3,
    carId: 9,
    carRecording: "boosted-replay",
    replayBoostSettings: {
      accelerationMultiplier: 1.8,
      brakingMultiplier: 1,
      topSpeedMultiplier: 1.2,
    },
  });
  assert.equal(status.hidden, false, "the status appears for the active Watch session");
  trackSelectionClick();
  assert.equal(
    status.hidden,
    true,
    "navigating to another track before playback ends clears its replay status",
  );

  watchClick("watch");
  worker.postMessage({
    messageType: 3,
    carId: 10,
    carRecording: "boosted-replay",
    replayBoostSettings: {
      accelerationMultiplier: 1.8,
      brakingMultiplier: 1,
      topSpeedMultiplier: 1.2,
    },
  });
  toolbarTrackNavigationClick("images/play.svg");
  assert.equal(
    status.hidden,
    true,
    "using Next Track before playback ends clears its replay status",
  );

  watchClick("watch");
  worker.postMessage({ messageType: 3, carId: 8, carRecording: "legacy-replay" });
  exitWatch();
  assert.equal(status.hidden, true, "exiting the game clears replay status immediately");
  closeAndReopenMenu();
});

test("an unrelated worker shutdown does not suppress the active replay status", () => {
  const { window, document, callbacks } = createBrowser();
  const replayWorker = new window.Worker("simulation_worker.bundle.js");
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const status = document.getElementById("polytrack-cheat-replay-status");
  const watchButton = {
    textContent: "Watch",
    querySelector(selector) {
      return selector === "img.button-icon"
        ? { getAttribute: (name) => name === "src" ? "images/preview.svg" : null }
        : null;
    },
  };
  document.dispatchEvent({
    type: "click",
    target: {
      closest: (selector) =>
        selector === ".track-info-ui .button" ? watchButton : null,
    },
  });

  const unrelatedWorker = new window.Worker("simulation_worker.bundle.js");
  unrelatedWorker.terminate();
  replayWorker.postMessage({
    messageType: 3,
    carId: 12,
    carRecording: "boosted-replay",
    replayBoostSettings: {
      accelerationMultiplier: 1.8,
      brakingMultiplier: 1,
      topSpeedMultiplier: 1.2,
    },
  });

  assert.equal(status.hidden, false);
  assert.match(status.textContent, /BOOSTED/);
});

test("native Watch entry shows private status without a click and survives worker replacement", () => {
  const { window, document, callbacks } = createBrowser();
  const worker = new window.Worker("simulation_worker.bundle.js");
  // Native Watch can be entered from the race result page, not the track-info button.
  window.__polytrackStartReplayWatch([{
    serialize: () => "native-boosted-recording",
    replayBoostSettings: {
      accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1,
    },
  }]);
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const status = document.getElementById("polytrack-cheat-replay-status");
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Replay boost: BOOSTED");
  worker.postMessage({ messageType: 3, carId: 42, carRecording: "native-boosted-recording" });
  worker.postMessage({ messageType: 4, carId: 42 });
  worker.terminate();
  assert.equal(status.hidden, false, "a replay rewind or worker replacement is not a Watch exit");
  assert.equal(status.textContent, "Replay boost: BOOSTED");
  document.getElementById("polytrack-cheat-close").click();
  document.getElementById("polytrack-cheat-launcher").click();
  assert.equal(status.hidden, false, "opening the menu mid-Watch retains the status");
  const backButton = {
    querySelector: () => ({ getAttribute: () => "images/back.svg" }),
  };
  document.dispatchEvent({
    type: "click",
    target: { closest: selector =>
      selector === ".preview-toolbar-ui .button" ? backButton : null },
  });
  assert.equal(status.hidden, true, "native Back hides status before its asynchronous transition");
  window.__polytrackEndReplayWatch();
  window.__polytrackStartReplayWatch([{
    serialize: () => "native-normal-recording", normalPhysicsConfirmed: true,
  }]);
  assert.equal(status.textContent, "Replay boost: NOT BOOSTED");
  window.__polytrackEndReplayWatch();
  window.__polytrackStartReplayWatch([{ serialize: () => "legacy-recording" }]);
  assert.match(status.textContent, /UNKNOWN/);
});

test("cheat multipliers support every whole percentage from 90% to 200%", () => {
  const { window, document, callbacks } = createBrowser();
  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({ messageType: 3, carId: 1, carRecording: null });
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }

  for (const key of [
    "accelerationMultiplier",
    "topSpeedMultiplier",
    "brakingMultiplier",
  ]) {
    const slider = document.getElementById(`polytrack-cheat-${key}`);
    assert.equal(slider.min, "0.9");
    assert.equal(slider.max, "2");
    assert.equal(slider.step, "0.01");
  }

  const acceleration = document.getElementById("polytrack-cheat-accelerationMultiplier");
  acceleration.value = "1.01";
  acceleration.listeners.input({ target: acceleration });
  assert.equal(window.__polytrackCheatSettings.accelerationMultiplier, 1.01);
  assert.equal(
    acceleration.parentElement.children[0].children[1].textContent,
    "101%",
  );
  worker.postMessage({ messageType: 6, carId: 1, up: true });
  assert.equal(worker.lastMessage.accelerationMultiplier, 1.01);

  acceleration.value = "0.9";
  acceleration.listeners.input({ target: acceleration });
  assert.equal(window.__polytrackCheatSettings.accelerationMultiplier, 0.9);
  assert.equal(
    acceleration.parentElement.children[0].children[1].textContent,
    "90%",
  );
  worker.postMessage({ messageType: 6, carId: 1, up: true });
  assert.equal(worker.lastMessage.accelerationBoost, true);
  assert.equal(worker.lastMessage.accelerationMultiplier, 0.9);

  worker.emitMessage({
    messageType: 10,
    __polytrackBoostFrames: [{
      carId: 1,
      frame: 1,
      settings: {
        accelerationMultiplier: 0.9,
        brakingMultiplier: 1,
        topSpeedMultiplier: 1,
      },
    }],
  });
  const recordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  window.localStorage.setItem(recordKey, JSON.stringify({
    uploadId: null,
    tokenHash: "a".repeat(64),
    frames: 100,
    recording: "reduced-acceleration-record",
  }));
  const savedRecord = JSON.parse(window.localStorage.getItem(recordKey));
  assert.equal(
    savedRecord.replayBoostSettings.accelerationMultiplier,
    0.9,
    "90% settings are saved for replay rather than treated as neutral",
  );
  assert.equal(savedRecord.replayBoostTimeline.segments[0].accelerationMultiplier, 0.9);
});

test("a saved boosted record keeps mid-race settings for replay after reload", () => {
  const { window, document, callbacks, storage } = createBrowser();
  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({ messageType: 3, carId: 1, carRecording: null });
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const acceleration = document.getElementById("polytrack-cheat-accelerationMultiplier");
  acceleration.value = "1.5";
  acceleration.listeners.input({ target: acceleration });
  const topSpeed = document.getElementById("polytrack-cheat-topSpeedMultiplier");
  topSpeed.value = "1.2";
  topSpeed.listeners.input({ target: topSpeed });
  worker.postMessage({ messageType: 6, carId: 1, up: true });
  worker.emitMessage({
    messageType: 10,
    __polytrackBoostFrames: [{
      carId: 1, frame: 1,
      settings: { accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
    }],
  });
  acceleration.value = "1.8";
  acceleration.listeners.input({ target: acceleration });
  worker.emitMessage({
    messageType: 10,
    __polytrackBoostFrames: [{
      carId: 1, frame: 2,
      settings: { accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
    }],
  });
  acceleration.value = "1";
  acceleration.listeners.input({ target: acceleration });
  worker.emitMessage({
    messageType: 10,
    __polytrackBoostFrames: [{
      carId: 1, frame: 3,
      settings: { accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
    }],
  });
  const recordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  storage.setItem(recordKey, JSON.stringify({
    uploadId: null, tokenHash: "a".repeat(64), frames: 100,
    recording: "boosted-controls",
  }));
  const savedRecord = JSON.parse(storage.getItem(recordKey));
  assert.deepEqual(
    { ...savedRecord.replayBoostSettings },
    { accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(savedRecord.replayBoostTimeline)), {
    version: 1,
    segments: [
      { startFrame: 1, endFrame: 1, accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
      { startFrame: 2, endFrame: 2, accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
      { startFrame: 3, endFrame: 3, accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
    ],
  });
  storage.setItem(recordKey, JSON.stringify({
    uploadId: 12,
    tokenHash: "a".repeat(64),
    frames: savedRecord.frames,
    recording: savedRecord.recording,
  }));
  const syncedRecord = JSON.parse(storage.getItem(recordKey));
  assert.deepEqual(syncedRecord.replayBoostSettings, savedRecord.replayBoostSettings,
    "a later same-record sync cannot strip its physics settings");
  assert.deepEqual(syncedRecord.replayBoostTimeline, savedRecord.replayBoostTimeline,
    "a later same-record sync cannot strip its physics timeline");

  const reloaded = createBrowser({ [recordKey]: JSON.stringify(savedRecord) });
  reloaded.storage.getItem(recordKey);
  const replayWorker = new reloaded.window.Worker("simulation_worker.bundle.js");
  replayWorker.postMessage({
    messageType: 3, carId: 2, carRecording: "boosted-controls",
  });
  assert.deepEqual(
    { ...replayWorker.lastMessage.replayBoostSettings },
    { accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
    "a recording keeps its own settings even when the hack is locked after reload",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(replayWorker.lastMessage.replayBoostTimeline)),
    savedRecord.replayBoostTimeline,
    "replay creation receives the saved per-frame settings timeline",
  );
  replayWorker.postMessage({
    messageType: 3, carId: 3, carRecording: "ordinary-controls",
  });
  assert.equal(replayWorker.lastMessage.replayBoostSettings, undefined,
    "ordinary recordings must not inherit the boost");
});

test("an older boosted PB can be repaired without changing an ordinary PB", () => {
  const oldKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const normalKey = `polytrack_v5_prod_record_0_default_${"b".repeat(64)}`;
  const oldRecord = {
    uploadId: null, tokenHash: "a".repeat(64), frames: 100,
    recording: "legacy-boosted-controls",
  };
  const normalRecord = {
    uploadId: null, tokenHash: "a".repeat(64), frames: 200,
    recording: "ordinary-controls",
  };
  const { window, document, callbacks, storage } = createBrowser({
    [oldKey]: JSON.stringify(oldRecord),
    [normalKey]: JSON.stringify(normalRecord),
  });
  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({
    messageType: 3, carId: 2, carRecording: "legacy-boosted-controls",
  });
  assert.equal(worker.lastMessage.replayBoostSettings, undefined);
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const acceleration = document.getElementById("polytrack-cheat-accelerationMultiplier");
  acceleration.value = "1.8";
  acceleration.listeners.input({ target: acceleration });
  const repair = document.getElementById("polytrack-cheat-repair-replay");
  assert.equal(repair.disabled, false);
  repair.click();
  assert.equal(repair.disabled, true);
  assert.deepEqual(
    { ...JSON.parse(storage.getItem(oldKey)).replayBoostSettings },
    { accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1 },
  );
  assert.equal(JSON.parse(storage.getItem(normalKey)).replayBoostSettings, undefined);
  worker.postMessage({
    messageType: 3, carId: 3, carRecording: "legacy-boosted-controls",
  });
  assert.equal(worker.lastMessage.replayBoostSettings.accelerationMultiplier, 1.8);
  worker.postMessage({
    messageType: 3, carId: 4, carRecording: "ordinary-controls",
  });
  assert.equal(worker.lastMessage.replayBoostSettings, undefined);
});

test("an explicitly repaired marked PB replaces stale boost metadata only on that record", () => {
  const recordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const ordinaryKey = `polytrack_v5_prod_record_0_default_${"c".repeat(64)}`;
  const savedSettings = {
    accelerationMultiplier: 1.4,
    brakingMultiplier: 1,
    topSpeedMultiplier: 1.1,
  };
  const savedTimeline = {
    version: 1,
    segments: [{
      startFrame: 1, endFrame: 100,
      accelerationMultiplier: 1.4, brakingMultiplier: 1, topSpeedMultiplier: 1.1,
    }],
  };
  const ordinaryRecord = {
    uploadId: null, tokenHash: "a".repeat(64), frames: 200,
    recording: "ordinary-controls",
  };
  const { window, document, callbacks, storage } = createBrowser({
    [recordKey]: JSON.stringify({
      uploadId: null, tokenHash: "a".repeat(64), frames: 100,
      recording: "stale-boost-controls",
      replayBoostSettings: savedSettings,
      replayBoostTimeline: savedTimeline,
    }),
    [ordinaryKey]: JSON.stringify(ordinaryRecord),
  });
  storage.getItem(recordKey);
  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({
    messageType: 3, carId: 2, carRecording: "stale-boost-controls",
  });
  assert.equal(worker.lastMessage.replayBoostSettings.accelerationMultiplier, 1.4);

  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const acceleration = document.getElementById("polytrack-cheat-accelerationMultiplier");
  acceleration.value = "1.8";
  acceleration.listeners.input({ target: acceleration });
  const repair = document.getElementById("polytrack-cheat-repair-replay");
  assert.equal(repair.disabled, false);
  repair.click();

  const repaired = JSON.parse(storage.getItem(recordKey));
  assert.deepEqual({ ...repaired.replayBoostSettings }, {
    accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1,
  });
  assert.equal(repaired.replayBoostTimeline, undefined,
    "the explicitly repaired constant settings replace a stale per-frame timeline");
  assert.deepEqual(JSON.parse(storage.getItem(ordinaryKey)), ordinaryRecord);

  worker.postMessage({
    messageType: 3, carId: 3, carRecording: "stale-boost-controls",
  });
  assert.equal(worker.lastMessage.replayBoostSettings.accelerationMultiplier, 1.8,
    "the next playback uses the explicitly repaired settings");
  assert.equal(worker.lastMessage.replayBoostTimeline, undefined);
});

test("an explicit normal-physics repair clears incorrect boost metadata", () => {
  const recordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const savedSettings = {
    accelerationMultiplier: 1.6,
    brakingMultiplier: 1,
    topSpeedMultiplier: 1.2,
  };
  const savedTimeline = {
    version: 1,
    segments: [{
      startFrame: 1, endFrame: 80,
      accelerationMultiplier: 1.6, brakingMultiplier: 1, topSpeedMultiplier: 1.2,
    }],
  };
  const { window, document, callbacks, storage } = createBrowser({
    [recordKey]: JSON.stringify({
      uploadId: null, tokenHash: "a".repeat(64), frames: 100,
      recording: "incorrectly-marked-controls",
      replayBoostSettings: savedSettings,
      replayBoostTimeline: savedTimeline,
    }),
  });
  storage.getItem(recordKey);
  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({
    messageType: 3, carId: 2, carRecording: "incorrectly-marked-controls",
  });
  assert.equal(worker.lastMessage.replayBoostSettings.accelerationMultiplier, 1.6);
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }

  const repair = document.getElementById("polytrack-cheat-repair-replay");
  assert.equal(repair.disabled, false);
  repair.click();

  const repaired = JSON.parse(storage.getItem(recordKey));
  assert.equal(repaired.replayBoostSettings, undefined);
  assert.equal(repaired.replayBoostTimeline, undefined);
  worker.postMessage({
    messageType: 3, carId: 3, carRecording: "incorrectly-marked-controls",
  });
  assert.equal(worker.lastMessage.replayBoostSettings, undefined,
    "the repaired replay returns to normal physics");
  assert.equal(worker.lastMessage.replayBoostTimeline, undefined);
});

test("leaderboard recordings transfer boost and confirmed-normal metadata into a fresh browser worker", () => {
  const { window } = createBrowser();
  const timeline = {
    version: 1,
    segments: [
      { startFrame: 1, endFrame: 12, accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.4 },
      { startFrame: 13, endFrame: 20, accelerationMultiplier: 1, brakingMultiplier: 1.2, topSpeedMultiplier: 1 },
    ],
  };
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "https://vps.kodub.com:43274/v6/recordings?ids=1,2");
  assert.equal(xhr.url, "/api/v6/recordings?ids=1,2");
  xhr.complete([
    { recording: "remote-boost", replayBoostSettings: {
      accelerationMultiplier: 1.8, brakingMultiplier: 1.2, topSpeedMultiplier: 1.4,
    }, replayBoostTimeline: timeline },
    { recording: "remote-normal" },
    { recording: "remote-confirmed-normal", normalPhysicsConfirmed: true },
  ]);
  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({ messageType: 3, carId: 1, carRecording: "remote-boost" });
  assert.deepEqual({ ...worker.lastMessage.replayBoostSettings }, {
    accelerationMultiplier: 1.8, brakingMultiplier: 1.2, topSpeedMultiplier: 1.4,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(worker.lastMessage.replayBoostTimeline)),
    timeline,
  );
  worker.postMessage({ messageType: 3, carId: 2, carRecording: "remote-normal" });
  assert.equal(worker.lastMessage.replayBoostSettings, undefined);
  worker.postMessage({
    messageType: 3, carId: 4, carRecording: "remote-confirmed-normal",
  });
  assert.equal(worker.lastMessage.replayBoostSettings, undefined);
  assert.equal(worker.lastMessage.normalPhysicsConfirmed, true,
    "the leaderboard's normal-physics confirmation reaches the replay worker");
  xhr.complete([{ recording: "remote-boost" }]);
  worker.postMessage({ messageType: 3, carId: 3, carRecording: "remote-boost" });
  assert.equal(worker.lastMessage.replayBoostSettings, undefined,
    "an older unmarked recording always uses ordinary physics");
});

test("shared replay settings reach the physics worker without being displayed", () => {
  const { window, document } = createBrowser();
  const timeline = {
    version: 1,
    segments: [
      { startFrame: 1, endFrame: 55, accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
      { startFrame: 56, endFrame: 100, accelerationMultiplier: 1, brakingMultiplier: 1.4, topSpeedMultiplier: 1 },
    ],
  };
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "/api/v6/recordings?ids=1,2,3");
  xhr.complete([
    {
      recording: "shared-boosted",
      replayBoostSettings: {
        accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.2,
      },
      replayBoostTimeline: timeline,
    },
    {
      recording: "settings-only",
      replayBoostSettings: {
        accelerationMultiplier: 1.6, brakingMultiplier: 1, topSpeedMultiplier: 1,
      },
    },
    { recording: "older-unmarked" },
  ]);

  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({
    messageType: 3, carId: 1, carRecording: "shared-boosted",
  });
  assert.deepEqual({ ...worker.lastMessage.replayBoostSettings }, {
    accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.2,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(worker.lastMessage.replayBoostTimeline)),
    timeline,
  );
  assert.equal(document.getElementById("polytrack-replay-boost-info"), null,
    "marked replay details are not exposed in the page");

  worker.postMessage({ messageType: 4, carId: 1 });
  assert.equal(document.getElementById("polytrack-replay-boost-info"), null);
  worker.postMessage({
    messageType: 3, carId: 1, carRecording: "older-unmarked",
  });
  assert.equal(document.getElementById("polytrack-replay-boost-info"), null,
    "unmarked replays also have no disclosure panel");

  worker.postMessage({
    messageType: 3, carId: 3, carRecording: "settings-only",
  });
  assert.deepEqual({ ...worker.lastMessage.replayBoostSettings }, {
    accelerationMultiplier: 1.6, brakingMultiplier: 1, topSpeedMultiplier: 1,
  });
  assert.equal(document.getElementById("polytrack-replay-boost-info"), null,
    "settings-only replays remain private too");
});

test("saved record uploads preserve boost and confirmed-normal metadata", async () => {
  const browser = createBrowser();
  const token = "boost-test";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  browser.storage.setItem("polytrack_v5_prod_user_0", JSON.stringify({
    token, nickname: "Driver", carStyle: "style",
  }));
  const settings = { accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.2 };
  const timeline = {
    version: 1,
    segments: [
      { startFrame: 1, endFrame: 55, accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
      { startFrame: 56, endFrame: 100, accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1 },
    ],
  };
  browser.storage.setItem(`polytrack_v5_prod_record_0_default_${hyperion}`, JSON.stringify({
    tokenHash, frames: 100, recording: "boosted-pb", replayBoostSettings: settings,
    replayBoostTimeline: timeline,
  }));
  browser.storage.setItem(`polytrack_v5_prod_record_0_undeterministic_${"b".repeat(64)}`, JSON.stringify({
    tokenHash, frames: 200, recording: "normal-pb", normalPhysicsConfirmed: true,
  }));
  await browser.runSync(browser.timers.shift());
  const uploads = browser.requests.filter((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(uploads[0].form.get("replayBoostSettings")), settings);
  assert.deepEqual(JSON.parse(uploads[0].form.get("replayBoostTimeline")), timeline);
  assert.equal(uploads[1].form.has("replayBoostSettings"), false);
  assert.equal(uploads[1].form.get("normalPhysicsConfirmed"), "true");
});

test("new local runs persist normal-physics confirmation but never infer it for boosted runs", () => {
  const { window, document, callbacks, storage } = createBrowser();
  const worker = new window.Worker("simulation_worker.bundle.js");
  const normalKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const unchangedLegacyKey =
    `polytrack_v5_prod_record_0_default_${"e".repeat(64)}`;
  storage.setItem(unchangedLegacyKey, JSON.stringify({
    frames: 75, recording: "old-unmarked-run",
  }));

  worker.postMessage({ messageType: 3, carId: 1, carRecording: null });
  worker.postMessage({ messageType: 6, carId: 1, up: true });
  worker.postMessage({ messageType: 4, carId: 1 });
  storage.setItem(unchangedLegacyKey, JSON.stringify({
    frames: 75, recording: "old-unmarked-run", uploadId: 9,
  }));
  assert.equal(
    JSON.parse(storage.getItem(unchangedLegacyKey)).normalPhysicsConfirmed,
    undefined,
    "a completed run cannot label an unchanged older replay during a metadata rewrite",
  );
  storage.setItem(normalKey, JSON.stringify({
    frames: 100, recording: "new-normal-run",
  }));
  assert.equal(
    JSON.parse(storage.getItem(normalKey)).normalPhysicsConfirmed,
    true,
    "normal controls on a newly completed run are explicitly recorded",
  );

  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const acceleration = document.getElementById("polytrack-cheat-accelerationMultiplier");
  acceleration.value = "1.8";
  acceleration.listeners.input({ target: acceleration });
  worker.postMessage({ messageType: 3, carId: 2, carRecording: null });
  worker.postMessage({ messageType: 6, carId: 2, up: true });
  const boostedSettings = {
    accelerationMultiplier: 1.8,
    brakingMultiplier: 1,
    topSpeedMultiplier: 1,
  };
  worker.emitMessage({
    __polytrackBoostFrames: [{ carId: 2, frame: 1, settings: boostedSettings }],
  });
  storage.setItem(normalKey, JSON.stringify({
    frames: 90, recording: "new-boosted-run", normalPhysicsConfirmed: true,
  }));
  const boostedRecord = JSON.parse(storage.getItem(normalKey));
  assert.deepEqual(
    boostedRecord.replayBoostSettings,
    boostedSettings,
    "the saved boosted run retains its physics settings",
  );
  assert.deepEqual(
    boostedRecord.replayBoostTimeline,
    {
      version: 1,
      segments: [{ startFrame: 1, endFrame: 1, ...boostedSettings }],
    },
    "the saved boosted run retains its per-frame physics timeline",
  );
  assert.equal(
    boostedRecord.normalPhysicsConfirmed,
    undefined,
    "a newer boosted replay cannot inherit an older replay's normal marker",
  );
  worker.postMessage({ messageType: 4, carId: 2 });
  assert.equal(window.__polytrackPendingReplayBoostSettings, null,
    "a record saved before worker shutdown does not leave stale boost metadata");
});

test("stored local normal confirmation reaches replay status while unmarked legacy data stays unknown", () => {
  const normalKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const legacyKey = `polytrack_v5_prod_record_0_default_${"d".repeat(64)}`;
  const { window, document, callbacks, storage } = createBrowser({
    [normalKey]: JSON.stringify({
      frames: 100, recording: "saved-normal", normalPhysicsConfirmed: true,
    }),
    [legacyKey]: JSON.stringify({ frames: 110, recording: "saved-legacy" }),
  });
  storage.getItem(normalKey);
  storage.getItem(legacyKey);
  const worker = new window.Worker("simulation_worker.bundle.js");
  for (const key of "jinitaimei114") {
    callbacks.keydown({ key, ctrlKey: false, metaKey: false, altKey: false });
  }
  const watchButton = {
    textContent: "Watch",
    querySelector(selector) {
      return selector === "img.button-icon"
        ? { getAttribute: (name) => name === "src" ? "images/preview.svg" : null }
        : null;
    },
  };
  document.dispatchEvent({
    type: "click",
    target: {
      closest: (selector) =>
        selector === ".track-info-ui .button" ? watchButton : null,
    },
  });
  const status = document.getElementById("polytrack-cheat-replay-status");
  worker.postMessage({ messageType: 3, carId: 7, carRecording: "saved-normal" });
  assert.match(status.textContent, /NOT BOOSTED/);
  worker.postMessage({ messageType: 3, carId: 8, carRecording: "saved-legacy" });
  assert.match(status.textContent, /1 NOT BOOSTED; 1 UNKNOWN/);
  assert.equal(worker.lastMessage.normalPhysicsConfirmed, undefined,
    "legacy replays are not assigned normal provenance during playback");
});

test("an unchanged ordinary PB is not marked when synced during a boosted run", () => {
  const { window, callbacks, storage } = createBrowser();
  const key = `polytrack_v5_prod_record_0_default_${hyperion}`;
  storage.setItem(key, JSON.stringify({ frames: 100, recording: "old-normal" }));
  const worker = new window.Worker("simulation_worker.bundle.js");
  worker.postMessage({ messageType: 3, carId: 1, carRecording: null });
  for (const keypress of "jinitaimei114") {
    callbacks.keydown({ key: keypress, ctrlKey: false, metaKey: false, altKey: false });
  }
  worker.postMessage({ messageType: 6, carId: 1, up: true });
  storage.setItem(key, JSON.stringify({ frames: 100, recording: "old-normal", uploadId: 2 }));
  assert.equal(JSON.parse(storage.getItem(key)).replayBoostSettings, undefined);
});

test("sync backfills an already-uploaded boosted PB missing replay metadata", async () => {
  const browser = createBrowser();
  const token = "backfill-test";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  browser.storage.setItem("polytrack_v5_prod_user_0", JSON.stringify({
    token, nickname: "Driver", carStyle: "style",
  }));
  browser.storage.setItem(`polytrack_v5_prod_record_0_default_${hyperion}`, JSON.stringify({
    tokenHash, frames: 100, recording: "original", uploadId: 5,
    replayBoostSettings: { accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
  }));
  browser.setLookup({ id: 5, frames: 100, hasReplayBoostSettings: false });
  await browser.runSync(browser.timers.shift());
  assert.equal(browser.requests[0].method, "GET");
  assert.equal(browser.requests[1].method, "POST");
  assert.ok(browser.requests[1].form.has("replayBoostSettings"));
});

test("sync backfills an already-uploaded normal PB missing its confirmation marker", async () => {
  const browser = createBrowser();
  const token = "normal-backfill-test";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  browser.storage.setItem("polytrack_v5_prod_user_0", JSON.stringify({
    token, nickname: "Driver", carStyle: "style",
  }));
  browser.storage.setItem(`polytrack_v5_prod_record_0_default_${hyperion}`, JSON.stringify({
    tokenHash,
    frames: 100,
    recording: "confirmed-normal",
    uploadId: 5,
    normalPhysicsConfirmed: true,
  }));
  browser.setLookup({
    id: 5,
    frames: 100,
    hasReplayBoostSettings: false,
    hasConfirmedNormalPhysics: false,
  });
  await browser.runSync(browser.timers.shift());
  assert.equal(browser.requests[0].method, "GET");
  assert.equal(browser.requests[1].method, "POST");
  assert.equal(browser.requests[1].form.get("normalPhysicsConfirmed"), "true");
});

test("syncs past Hyperion and other map PBs and reuploads improvements", async () => {
  const browser = createBrowser();
  const { storage, requests } = browser;
  const token = "test-token";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  storage.setItem("polytrack_v5_prod_user_0", JSON.stringify({
    token, nickname: "Driver", carStyle: "style",
  }));
  const hyperionKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const otherId = "a".repeat(64);
  const otherKey = `polytrack_v5_prod_record_0_undeterministic_${otherId}`;
  storage.setItem(hyperionKey, JSON.stringify({
    uploadId: null, tokenHash, frames: 150, recording: "run1",
  }));
  storage.setItem(otherKey, JSON.stringify({
    uploadId: null, tokenHash, frames: 200, recording: "run2",
  }));

  await browser.runSync(browser.timers.shift());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].form.get("trackId"), hyperion);
  assert.equal(requests[0].form.get("onlyVerified"), "true");
  assert.equal(requests[1].form.get("trackId"), otherId);
  assert.equal(requests[1].form.get("onlyVerified"), "false");
  assert.equal(JSON.parse(storage.getItem(hyperionKey)).uploadId, 1);
  assert.equal(JSON.parse(storage.getItem(otherKey)).uploadId, null);

  await browser.runSync(browser.intervals[0]);
  assert.equal(requests.length, 2, "unchanged PBs are not uploaded repeatedly");
  storage.setItem(hyperionKey, JSON.stringify({
    uploadId: null, tokenHash, frames: 120, recording: "run3",
  }));
  browser.fail();
  await browser.runSync(browser.intervals[0]);
  assert.equal(JSON.parse(storage.getItem(hyperionKey)).uploadId, null);
  await browser.runSync(browser.intervals[0]);
  assert.equal(requests.length, 4, "failed upload retries on next sync");
  assert.equal(JSON.parse(storage.getItem(hyperionKey)).uploadId, 4);

  storage.removeItem(hyperionKey);
  assert.equal(storage.getItem(hyperionKey), null, "explicit deletes still work");
});

test("does not upload PBs belonging to an old profile in the same slot", async () => {
  const browser = createBrowser();
  browser.storage.setItem("polytrack_v5_prod_user_0", JSON.stringify({
    token: "new-token", nickname: "Driver", carStyle: "style",
  }));
  browser.storage.setItem(`polytrack_v5_prod_record_0_default_${hyperion}`, JSON.stringify({
    tokenHash: "b".repeat(64), frames: 150, recording: "old-run",
  }));
  await browser.runSync(browser.timers.shift());
  assert.equal(browser.requests.length, 0);
});

test("startup cleanup cannot erase a map PB, but explicit deletion can", () => {
  const browser = createBrowser();
  const key = `polytrack_v5_prod_record_0_default_${hyperion}`;
  browser.storage.setItem(key, "saved PB");
  function cleanUpRecords() { browser.storage.removeItem(key); }
  cleanUpRecords();
  assert.equal(browser.storage.getItem(key), "saved PB");
  browser.storage.removeItem(key);
  assert.equal(browser.storage.getItem(key), null);
});

test("deleting a disposable player's PB refreshes only the selected leaderboard and PB display", async () => {
  const token = "delete-own-pb-token";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  const otherTrackId = "c".repeat(64);
  const otherPlayerId = "e".repeat(64);
  const otherMapPlayerId = "f".repeat(64);
  const defaultKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const undeterministicKey =
    `polytrack_v5_prod_record_0_undeterministic_${hyperion}`;
  const otherTrackKey = `polytrack_v5_prod_record_0_default_${otherTrackId}`;
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token, nickname: "Driver", carStyle: "style",
    }),
    [defaultKey]: JSON.stringify({ tokenHash, frames: 120, recording: "selected-default" }),
    [undeterministicKey]: JSON.stringify({
      tokenHash, frames: 140, recording: "selected-undeterministic",
    }),
    [otherTrackKey]: JSON.stringify({ tokenHash, frames: 200, recording: "other-map" }),
  });
  const selectedMap = createLeaderboardView(
    browser.document,
    [{ name: "Disposable driver" }, { name: "Other player" }],
    2,
    ["01:23.456", "01:23.456"],
  );
  let nativeRefreshCount = 0;
  selectedMap.leaderboard.__polytrackRefreshLeaderboard = () => { nativeRefreshCount += 1; };
  const otherMap = createLeaderboardView(
    browser.document,
    [
      { name: "Disposable driver", userId: tokenHash },
      { name: "Other map player", userId: otherMapPlayerId },
    ],
    2,
    ["02:34.567"],
  );
  browser.document.querySelector = (selector) => {
    if (selector === ".track-info-ui .leaderboard-ui") return selectedMap.leaderboard;
    if (selector === ".track-info-ui .side-panel .personal-best") {
      return selectedMap.personalBest;
    }
    return null;
  };
  const xhr = new browser.window.XMLHttpRequest();
  const button = browser.document.createElement("button");
  button.classList.add("button", "only-verified", "disabled");
  let verifiedFilterToggleCount = 0;
  button.addEventListener("click", () => { verifiedFilterToggleCount += 1; });
  assert.equal(browser.window.__polytrackInstallOwnPbDeleteControl(button), true);
  assert.equal(button.textContent, "Delete PB");
  const featureStyles = browser.document.head.children.find((element) =>
    element.tagName === "style",
  )?.textContent;
  assert.match(featureStyles, /\.button\.polytrack-delete-pb\s*\{[^}]*font:\s*600 14px\/1\.2 system-ui,\s*sans-serif !important;[^}]*text-transform:\s*none !important;/s);
  assert.equal(button.classList.contains("only-verified"), false);
  assert.equal(button.classList.contains("disabled"), false);
  assert.equal(button.disabled, true, "waits for this map's leaderboard query");
  xhr.open(
    "GET",
    `/api/v6/leaderboard?version=v6&trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
  );
  xhr.complete({ entries: [{ userId: tokenHash }, { userId: otherPlayerId }] });
  const rowTaggingTimer = browser.timers.at(-1);
  assert.equal(rowTaggingTimer.delay, 0);
  rowTaggingTimer();
  assert.equal(button.disabled, false);

  button.click();
  await button.__polytrackDeletePromise;

  assert.equal(browser.confirmationCount, 1);
  assert.equal(verifiedFilterToggleCount, 0, "deletion does not toggle the filter control");
  const deletion = browser.requests.find((request) => request.method === "DELETE");
  assert.ok(deletion);
  assert.equal(deletion.url, "/api/v6/leaderboard");
  assert.equal(deletion.form.get("userToken"), token);
  assert.equal(deletion.form.get("trackId"), hyperion);
  assert.equal(browser.storage.getItem(defaultKey), null);
  assert.equal(browser.storage.getItem(undeterministicKey), null);
  assert.ok(browser.storage.getItem(otherTrackKey), "the player's other map PB stays intact");
  assert.equal(button.textContent, "PB deleted");
  assert.equal(nativeRefreshCount, 1, "refreshes the game's own leaderboard/PB state");
  assert.deepEqual(
    selectedMap.container.children.map((row) => row.textContent),
    ["Other player"],
    "the deleted player's selected-map row is removed and other players remain",
  );
  assert.equal(selectedMap.count.textContent, "1 players");
  assert.deepEqual(
    selectedMap.personalBest.querySelectorAll("span").map((span) => span.textContent),
    ["---", "---"],
    "the selected map's personal-best display is cleared",
  );
  assert.ok(
    selectedMap.personalBest.querySelectorAll("span").every((span) =>
      span.classList.contains("faded"),
    ),
    "cleared personal-best values use the faded state",
  );
  assert.deepEqual(
    otherMap.container.children.map((row) => row.textContent),
    ["Disposable driver", "Other map player"],
    "rows on a different map are unaffected",
  );
  assert.equal(otherMap.count.textContent, "2 players");
  assert.equal(otherMap.personalBest.querySelector("span").textContent, "02:34.567");

  await browser.runSync(browser.intervals[0]);
  assert.equal(
    browser.requests.some((request) =>
      request.method === "POST" && request.form.get("trackId") === hyperion),
    false,
    "background sync does not restore a deleted PB",
  );
});

for (const [responseDescription, response] of [
  ["malformed JSON", {
    ok: true,
    json: async () => { throw new SyntaxError("Malformed mocked JSON"); },
  }],
  ["an invalid deleted-record count", {
    ok: true,
    json: async () => ({ deletedRecords: -1 }),
  }],
]) {
  test(`a confirmed PB deletion cleans local state despite ${responseDescription}`, async () => {
    const token = `mock-disposable-${responseDescription.replaceAll(" ", "-")}-token`;
    const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
    const key = `polytrack_v5_prod_record_0_default_${hyperion}`;
    const browser = createBrowser({
      "polytrack_v5_prod_user_slot": "0",
      "polytrack_v5_prod_user_0": JSON.stringify({
        token, nickname: "Disposable test driver", carStyle: "style",
      }),
      [key]: JSON.stringify({ tokenHash, frames: 120, recording: "disposable-test-pb" }),
    });
    const leaderboard = createLeaderboardView(
      browser.document,
      [{ name: "Disposable test driver", userId: tokenHash }, { name: "Other player" }],
      2,
      ["01:23.456"],
    );
    browser.document.querySelector = (selector) => {
      if (selector === ".track-info-ui .leaderboard-ui") return leaderboard.leaderboard;
      if (selector === ".track-info-ui .side-panel .personal-best") {
        return leaderboard.personalBest;
      }
      return null;
    };
    const button = browser.document.createElement("button");
    button.classList.add("button", "only-verified");
    browser.window.__polytrackInstallOwnPbDeleteControl(button);
    new browser.window.XMLHttpRequest().open(
      "GET",
      `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
    );
    assert.equal(button.disabled, false);

    browser.setConfirm(true);
    browser.setNextDeleteResponse(response);
    button.click();
    await button.__polytrackDeletePromise;

    assert.equal(browser.requests.length, 1, "only the mocked DELETE is requested");
    assert.equal(browser.requests[0].method, "DELETE");
    assert.equal(browser.requests[0].url, "/api/v6/leaderboard");
    assert.equal(browser.requests[0].form.get("userToken"), token);
    assert.equal(browser.storage.getItem(key), null, "the disposable local PB is removed");
    assert.deepEqual(
      leaderboard.container.children.map((row) => row.textContent),
      ["Other player"],
      "the confirmed deletion updates the selected leaderboard",
    );
    assert.equal(leaderboard.count.textContent, "1 players");
    assert.equal(button.textContent, "PB deleted");
    assert.equal(
      browser.document.getElementById("site-feature-toast").textContent,
      "Personal best deleted from this device and the leaderboard.",
      "the user sees success because the server confirmed deletion",
    );
  });
}

test("preserves a faster same-map PB saved while deletion is pending", async () => {
  const token = "delete-racing-pb-token";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  const key = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const replacement = {
    tokenHash,
    frames: 90,
    recording: "faster-replacement-run",
  };
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token, nickname: "Driver", carStyle: "style",
    }),
    [key]: JSON.stringify({
      tokenHash, frames: 120, recording: "original-run",
    }),
  });
  const button = browser.document.createElement("button");
  button.classList.add("button", "only-verified");
  browser.window.__polytrackInstallOwnPbDeleteControl(button);
  new browser.window.XMLHttpRequest().open(
    "GET",
    `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
  );
  assert.equal(button.disabled, false);

  browser.setConfirm(true);
  const pendingDelete = browser.deferNextDelete();
  button.click();
  await pendingDelete.requested;

  browser.storage.setItem(key, JSON.stringify(replacement));
  pendingDelete.complete();
  await button.__polytrackDeletePromise;

  assert.deepEqual(
    JSON.parse(browser.storage.getItem(key)),
    replacement,
    "completion of the older deletion leaves the faster replacement available locally",
  );
});

test("a late PB deletion for the previous map leaves the newly selected map unchanged", async () => {
  const token = "late-map-delete-disposable-token";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  const mapBId = "c".repeat(64);
  const mapARecordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token, nickname: "Disposable driver", carStyle: "style",
    }),
    [mapARecordKey]: JSON.stringify({
      tokenHash, frames: 120, recording: "disposable-map-a-pb",
    }),
  });

  const mapA = createLeaderboardView(
    browser.document,
    [{ name: "Disposable driver", userId: tokenHash }, { name: "Map A rival" }],
    2,
    ["01:23.456"],
  );
  const mapB = createLeaderboardView(
    browser.document,
    [{ name: "Disposable driver", userId: tokenHash }, { name: "Map B rival" }],
    2,
    ["02:34.567", "02:35.678"],
  );
  let visibleMap = mapA;
  browser.document.querySelector = (selector) => {
    if (selector === ".track-info-ui .leaderboard-ui") return visibleMap.leaderboard;
    if (selector === ".track-info-ui .side-panel .personal-best") {
      return visibleMap.personalBest;
    }
    return null;
  };

  const mapAButton = browser.document.createElement("button");
  mapAButton.classList.add("button", "only-verified");
  browser.window.__polytrackInstallOwnPbDeleteControl(mapAButton);
  const mapAXhr = new browser.window.XMLHttpRequest();
  mapAXhr.open(
    "GET",
    `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
  );
  mapAXhr.complete({ entries: [{ userId: tokenHash }, { userId: "e".repeat(64) }] });
  assert.equal(mapAButton.disabled, false);

  browser.setConfirm(true);
  const pendingDelete = browser.deferNextDelete();
  mapAButton.click();
  await pendingDelete.requested;

  visibleMap = mapB;
  const mapBButton = browser.document.createElement("button");
  mapBButton.classList.add("button", "only-verified");
  browser.window.__polytrackInstallOwnPbDeleteControl(mapBButton);
  const mapBXhr = new browser.window.XMLHttpRequest();
  mapBXhr.open(
    "GET",
    `/api/v6/leaderboard?trackId=${mapBId}&skip=0&amount=20&onlyVerified=true`,
  );
  mapBXhr.complete({ entries: [{ userId: tokenHash }, { userId: "f".repeat(64) }] });
  assert.equal(mapBButton.disabled, false);

  pendingDelete.complete();
  await mapAButton.__polytrackDeletePromise;

  assert.deepEqual(
    mapB.container.children.map((row) => row.textContent),
    ["Disposable driver", "Map B rival"],
    "the old map's response does not remove a row from the newly selected map",
  );
  assert.equal(mapB.count.textContent, "2 players",
    "the newly selected map's player count remains unchanged");
  assert.deepEqual(
    mapB.personalBest.querySelectorAll("span").map((span) => span.textContent),
    ["02:34.567", "02:35.678"],
    "the newly selected map's personal-best display remains unchanged",
  );
  assert.ok(
    mapB.personalBest.querySelectorAll("span").every((span) =>
      !span.classList.contains("faded"),
    ),
    "the newly selected map's personal-best values are not cleared or faded",
  );
  assert.equal(browser.storage.getItem(mapARecordKey), null,
    "only the disposable local PB for map A is deleted");
  assert.equal(
    browser.requests.find((request) => request.method === "DELETE").form.get("trackId"),
    hyperion,
    "the mocked deletion targets map A",
  );
});

test("a late PB deletion does not clear the newly selected profile's PB", async () => {
  const initiatingToken = "late-delete-initiating-profile-token";
  const selectedToken = "late-delete-selected-profile-token";
  const initiatingTokenHash = require("node:crypto")
    .createHash("sha256").update(initiatingToken).digest("hex");
  const selectedTokenHash = require("node:crypto")
    .createHash("sha256").update(selectedToken).digest("hex");
  const initiatingRecordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const selectedRecordKey = `polytrack_v5_prod_record_1_default_${hyperion}`;
  const selectedRecord = JSON.stringify({
    tokenHash: selectedTokenHash,
    frames: 180,
    recording: "selected-profile-pb",
  });
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token: initiatingToken, nickname: "Initiating driver", carStyle: "style",
    }),
    "polytrack_v5_prod_user_1": JSON.stringify({
      token: selectedToken, nickname: "Selected driver", carStyle: "style",
    }),
    [initiatingRecordKey]: JSON.stringify({
      tokenHash: initiatingTokenHash,
      frames: 120,
      recording: "initiating-profile-pb",
    }),
    [selectedRecordKey]: selectedRecord,
  });
  const profileAView = createLeaderboardView(
    browser.document,
    [{ name: "Initiating driver", userId: initiatingTokenHash }, { name: "Rival" }],
    2,
    ["01:23.456"],
  );
  const profileBView = createLeaderboardView(
    browser.document,
    [{ name: "Initiating driver", userId: initiatingTokenHash }, { name: "Rival" }],
    2,
    ["02:34.567", "02:35.678"],
  );
  let visibleView = profileAView;
  browser.document.querySelector = (selector) => {
    if (selector === ".track-info-ui .leaderboard-ui") return visibleView.leaderboard;
    if (selector === ".track-info-ui .side-panel .personal-best") {
      return visibleView.personalBest;
    }
    return null;
  };

  const button = browser.document.createElement("button");
  button.classList.add("button", "only-verified");
  browser.window.__polytrackInstallOwnPbDeleteControl(button);
  new browser.window.XMLHttpRequest().open(
    "GET",
    `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
  );
  assert.equal(button.disabled, false);

  browser.setConfirm(true);
  const pendingDelete = browser.deferNextDelete();
  button.click();
  await pendingDelete.requested;

  browser.storage.setItem("polytrack_v5_prod_user_slot", "1");
  visibleView = profileBView;
  pendingDelete.complete();
  await button.__polytrackDeletePromise;

  const deletion = browser.requests.find((request) => request.method === "DELETE");
  assert.equal(deletion.form.get("userToken"), initiatingToken,
    "the request continues to use only the profile that started the deletion");
  assert.notEqual(deletion.form.get("userToken"), selectedToken);
  assert.equal(deletion.form.get("trackId"), hyperion);
  assert.equal(browser.storage.getItem(initiatingRecordKey), null,
    "the initiating profile's local PB is deleted");
  assert.equal(browser.storage.getItem(selectedRecordKey), selectedRecord,
    "the newly selected profile's local PB remains unchanged");
  assert.deepEqual(
    profileBView.personalBest.querySelectorAll("span").map((span) => span.textContent),
    ["02:34.567", "02:35.678"],
    "the newly selected profile's displayed PB remains unchanged",
  );
  assert.ok(
    profileBView.personalBest.querySelectorAll("span").every((span) =>
      !span.classList.contains("faded"),
    ),
    "the newly selected profile's displayed PB is not marked as deleted",
  );
  assert.equal(button.textContent, "Delete PB",
    "the control remains available for the newly selected profile");
});

test("deleting one profile's map PB preserves another profile's PB for that map", async () => {
  const activeToken = "active-disposable-profile-token";
  const otherToken = "other-disposable-profile-token";
  const activeTokenHash = require("node:crypto")
    .createHash("sha256").update(activeToken).digest("hex");
  const otherTokenHash = require("node:crypto")
    .createHash("sha256").update(otherToken).digest("hex");
  const activeRecordKey = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const otherRecordKey = `polytrack_v5_prod_record_1_default_${hyperion}`;
  const activeRecord = JSON.stringify({
    tokenHash: activeTokenHash, frames: 120, recording: "active-profile-run",
  });
  const otherRecord = JSON.stringify({
    tokenHash: otherTokenHash, frames: 150, recording: "other-profile-run",
  });
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token: activeToken, nickname: "Active disposable driver", carStyle: "style",
    }),
    "polytrack_v5_prod_user_1": JSON.stringify({
      token: otherToken, nickname: "Other disposable driver", carStyle: "style",
    }),
    [activeRecordKey]: activeRecord,
    [otherRecordKey]: otherRecord,
  });
  const selectedMap = createLeaderboardView(
    browser.document,
    [
      { name: "Active disposable driver", userId: activeTokenHash },
      { name: "Other disposable driver", userId: otherTokenHash },
    ],
    2,
    ["01:23.456"],
  );
  browser.document.querySelector = (selector) => {
    if (selector === ".track-info-ui .leaderboard-ui") return selectedMap.leaderboard;
    if (selector === ".track-info-ui .side-panel .personal-best") {
      return selectedMap.personalBest;
    }
    return null;
  };
  const button = browser.document.createElement("button");
  button.classList.add("button", "only-verified");
  assert.equal(browser.window.__polytrackInstallOwnPbDeleteControl(button), true);
  const xhr = new browser.window.XMLHttpRequest();
  xhr.open(
    "GET",
    `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
  );
  xhr.complete({ entries: [
    { userId: activeTokenHash },
    { userId: otherTokenHash },
  ] });
  browser.timers.at(-1)();
  assert.equal(button.disabled, false);

  button.click();
  await button.__polytrackDeletePromise;

  const deletions = browser.requests.filter((request) => request.method === "DELETE");
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0].form.get("userToken"), activeToken);
  assert.notEqual(deletions[0].form.get("userToken"), otherToken);
  assert.equal(deletions[0].form.get("trackId"), hyperion);
  assert.equal(browser.storage.getItem(activeRecordKey), null);
  assert.equal(
    browser.storage.getItem(otherRecordKey),
    otherRecord,
    "the other profile's PB for the same map remains unchanged",
  );
  assert.deepEqual(
    selectedMap.container.children.map((row) => row.textContent),
    ["Other disposable driver"],
    "only the active profile's leaderboard row is removed",
  );
});

test("cancelling or failing PB deletion keeps local records available", async () => {
  const token = "delete-retry-token";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  const key = `polytrack_v5_prod_record_0_default_${hyperion}`;
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token, nickname: "Driver", carStyle: "style",
    }),
    [key]: JSON.stringify({ tokenHash, frames: 120, recording: "keep-if-delete-fails" }),
  });
  const button = browser.document.createElement("button");
  button.classList.add("button", "only-verified");
  browser.window.__polytrackInstallOwnPbDeleteControl(button);
  new browser.window.XMLHttpRequest().open(
    "GET",
    `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
  );
  assert.equal(button.disabled, false);

  browser.setConfirm(false);
  button.click();
  assert.ok(browser.storage.getItem(key), "cancelled deletion leaves the local PB");
  assert.equal(browser.requests.length, 0);

  browser.setConfirm(true);
  browser.fail();
  button.click();
  await button.__polytrackDeletePromise;
  assert.ok(browser.storage.getItem(key), "server failure leaves the local PB");
  assert.equal(
    browser.storage.getItem(`polytrack_leaderboard_deleted_pb_v1_${key}`),
    null,
    "a failed deletion does not block later leaderboard sync",
  );
  assert.equal(button.textContent, "Delete PB");
});

test("a newly selected map cannot reuse the previous map's delete target", async () => {
  const token = "delete-current-map-token";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  const otherTrackId = "d".repeat(64);
  const otherTrackKey = `polytrack_v5_prod_record_0_default_${otherTrackId}`;
  const browser = createBrowser({
    "polytrack_v5_prod_user_slot": "0",
    "polytrack_v5_prod_user_0": JSON.stringify({
      token, nickname: "Driver", carStyle: "style",
    }),
    [otherTrackKey]: JSON.stringify({
      tokenHash, frames: 180, recording: "newly-selected-map",
    }),
  });
  const firstButton = browser.document.createElement("button");
  firstButton.classList.add("button", "only-verified");
  browser.window.__polytrackInstallOwnPbDeleteControl(firstButton);
  new browser.window.XMLHttpRequest().open(
    "GET",
    `/api/v6/leaderboard?trackId=${hyperion}&skip=0&amount=20&onlyVerified=true`,
  );
  assert.equal(firstButton.disabled, false);

  const secondButton = browser.document.createElement("button");
  secondButton.classList.add("button", "only-verified");
  browser.window.__polytrackInstallOwnPbDeleteControl(secondButton);
  assert.equal(secondButton.disabled, true, "the previous map ID is cleared");
  browser.setConfirm(true);
  secondButton.click();
  assert.equal(browser.confirmationCount, 0, "deletion waits for the new map");

  new browser.window.XMLHttpRequest().open(
    "GET",
    `/api/v6/leaderboard?trackId=${otherTrackId}&skip=0&amount=20&onlyVerified=true`,
  );
  assert.equal(secondButton.disabled, false);
  secondButton.click();
  await secondButton.__polytrackDeletePromise;
  const deletion = browser.requests.find((request) => request.method === "DELETE");
  assert.equal(deletion.form.get("trackId"), otherTrackId);
  assert.equal(browser.storage.getItem(otherTrackKey), null);
});

test("re-uploads an unchanged PB if a restarted leaderboard has lost it", async () => {
  const first = createBrowser();
  const token = "test-token";
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  const key = `polytrack_v5_prod_record_0_default_${hyperion}`;
  first.storage.setItem("polytrack_v5_prod_user_0", JSON.stringify({
    token, nickname: "Driver", carStyle: "style",
  }));
  first.storage.setItem(key, JSON.stringify({
    uploadId: null, tokenHash, frames: 120, recording: "saved-run",
  }));
  await first.runSync(first.timers.shift());
  const nextVisit = createBrowser(Object.fromEntries(Object.entries(first.storage)));
  await nextVisit.runSync(nextVisit.timers.shift());
  assert.equal(nextVisit.requests[0].method, "GET");
  assert.equal(nextVisit.requests[0].url.includes(hyperion), true);
  assert.equal(nextVisit.requests[1].method, "POST");
  assert.equal(nextVisit.requests[1].form.get("frames"), "120");
});

test("rewrites PolyTrack multiplayer WebSockets to same-origin API WSS", () => {
  const browser = createBrowser();
  const hostSocket = new browser.window.WebSocket(
    "wss://vps.kodub.com:43274/v6/multiplayer/host",
    ["polytrack"],
  );
  const joinSocket = new browser.window.WebSocket(
    "https://vps.kodub.com:43274/v6/multiplayer/join",
  );
  const unrelatedSocket = new browser.window.WebSocket(
    "wss://example.com/v6/multiplayer/join",
  );

  assert.equal(
    hostSocket.url,
    "wss://polytrack.example/api/v6/multiplayer/host",
  );
  assert.deepEqual(hostSocket.protocols, ["polytrack"]);
  assert.equal(
    joinSocket.url,
    "wss://polytrack.example/api/v6/multiplayer/join",
  );
  assert.equal(
    unrelatedSocket.url,
    "wss://example.com/v6/multiplayer/join",
  );
});