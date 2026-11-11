(() => {
  "use strict";

  const cheatCode = "jinitaimei114";
  const cheatMenuDurationMs = 10_000;
  const cheatSettingsKey = "polytrack_cheat_settings_v1";
  const defaultCheatSettings = {
    accelerationMultiplier: 1,
    topSpeedMultiplier: 1,
    brakingMultiplier: 1,
  };
  const sliderSettings = [
    {
      key: "accelerationMultiplier",
      label: "Acceleration",
      description: "Scales the accelerator effect while it is held.",
    },
    {
      key: "topSpeedMultiplier",
      label: "Top speed",
      description: "Scales the speed reported to the HUD; the native vehicle speed cap is unchanged.",
    },
    {
      key: "brakingMultiplier",
      label: "Braking",
      description: "Scales the brake effect while it is held.",
    },
  ];
  let typed = "";
  let boostEnabled = false;
  let cheatMenu;
  let cheatLauncher;
  let cheatMenuCloseButton;
  let replayBoostStatusElement;
  let replayRepairButton;
  let lastReplayToRepair = null;
  let repairingRecordKey = null;
  let nicknameUpdatePromise = null;
  let cheatMenuTimeout;
  let cheatMenuAvailable = false;
  const simulationWorkers = new Set();
  const cheatControls = new Map();

  function normalizeMultiplier(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.round(Math.min(2, Math.max(0.9, number)) * 100) / 100;
  }

  function normalizeBoostValues(value) {
    if (!value || typeof value !== "object") return null;
    const values = {
      accelerationMultiplier: normalizeMultiplier(value.accelerationMultiplier, 1),
      brakingMultiplier: normalizeMultiplier(value.brakingMultiplier, 1),
      topSpeedMultiplier: normalizeMultiplier(value.topSpeedMultiplier, 1),
    };
    return values;
  }

  function normalizeReplayBoostSettings(value) {
    const settings = normalizeBoostValues(value);
    if (!settings) return null;
    return Object.values(settings).some((multiplier) => multiplier !== 1)
      ? settings
      : null;
  }

  function normalizeReplayBoostTimeline(value) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object" || value.version !== 1 ||
        !Array.isArray(value.segments) || value.segments.length < 1 ||
        value.segments.length > 10_000) return null;
    const segments = [];
    let previousEndFrame = 0;
    let hasBoost = false;
    for (const segment of value.segments) {
      const settings = normalizeBoostValues(segment);
      if (!settings || !Number.isSafeInteger(segment.startFrame) ||
          !Number.isSafeInteger(segment.endFrame) || segment.startFrame < 1 ||
          segment.endFrame < segment.startFrame || segment.endFrame > 2_000_000 ||
          segment.startFrame <= previousEndFrame ||
          Object.keys(settings).some((key) =>
            typeof segment[key] !== "number" || !Number.isFinite(segment[key]) ||
            segment[key] < 0.9 || segment[key] > 2
          )) return null;
      previousEndFrame = segment.endFrame;
      hasBoost ||= Object.values(settings).some((multiplier) => multiplier !== 1);
      segments.push({
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        ...settings,
      });
    }
    return hasBoost ? { version: 1, segments } : null;
  }

  function clearPersistedCheatSettings() {
    try {
      window.localStorage.removeItem(cheatSettingsKey);
    } catch {
      // The neutral defaults still apply for this page when storage is unavailable.
    }
  }

  clearPersistedCheatSettings();
  const cheatSettings = { ...defaultCheatSettings };

  function publishCheatSettings() {
    window.__polytrackCheatUnlocked = boostEnabled;
    window.__polytrackCheatSettings = boostEnabled
      ? { ...cheatSettings }
      : {
          accelerationMultiplier: 1,
          topSpeedMultiplier: 1,
          brakingMultiplier: 1,
        };
    window.__polytrackAccelerationBoost = Boolean(
      boostEnabled &&
      (cheatSettings.accelerationMultiplier > 1 || cheatSettings.brakingMultiplier > 1),
    );
    if (boostEnabled) {
      for (const worker of simulationWorkers) worker.refreshCheatSettings?.();
    }
  }

  const style = document.createElement("style");
  style.textContent = `
    #site-feature-toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      z-index: 1000;
      transform: translateX(-50%) translateY(12px);
      padding: 10px 16px;
      border: 1px solid rgba(255,255,255,.22);
      border-radius: 4px;
      background: rgba(12,16,25,.94);
      color: #fff;
      font: 16px/1.2 system-ui, sans-serif;
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s ease, transform .18s ease;
    }
    #site-feature-toast.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    #polytrack-cheat-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(3, 7, 15, .78);
      font: 15px/1.45 system-ui, sans-serif;
      color: #f3f6fc;
    }
    #polytrack-cheat-backdrop[hidden] { display: none !important; }
    #polytrack-cheat-panel {
      width: min(440px, 100%);
      max-height: min(90vh, 700px);
      overflow: auto;
      box-sizing: border-box;
      padding: 24px;
      border: 1px solid rgba(151, 181, 229, .42);
      border-radius: 12px;
      background: linear-gradient(155deg, #18243a, #0b111f 74%);
      box-shadow: 0 24px 80px rgba(0, 0, 0, .56);
      text-align: left;
    }
    #polytrack-cheat-panel * { box-sizing: border-box; }
    .polytrack-cheat-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 20px;
    }
    .polytrack-cheat-kicker {
      margin: 0 0 5px;
      color: #9fb6d9;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    #polytrack-cheat-panel h2 {
      margin: 0;
      color: #fff;
      font-size: 25px;
      line-height: 1.15;
    }
    .polytrack-cheat-close,
    .polytrack-cheat-reset,
    #polytrack-cheat-launcher {
      border: 1px solid rgba(178, 198, 230, .35);
      border-radius: 7px;
      background: rgba(255, 255, 255, .08);
      color: #f3f6fc;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    .polytrack-cheat-close {
      flex: 0 0 auto;
      width: 36px;
      height: 36px;
      font-size: 22px;
      line-height: 1;
    }
    .polytrack-cheat-row {
      display: block;
      margin: 0 0 17px;
      padding: 14px;
      border: 1px solid rgba(151, 181, 229, .16);
      border-radius: 9px;
      background: rgba(255, 255, 255, .035);
      text-align: left;
    }
    .polytrack-cheat-row-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 5px;
      font-weight: 700;
    }
    .polytrack-cheat-value {
      color: #8ac7ff;
      font-variant-numeric: tabular-nums;
    }
    .polytrack-cheat-description,
    .polytrack-cheat-note {
      display: block;
      margin: 0;
      color: #aab7ca;
      font-size: 12px;
      line-height: 1.45;
    }
    .polytrack-cheat-replay-status {
      margin: 0 0 17px;
      padding: 11px 13px;
      border: 1px solid rgba(105, 185, 255, .32);
      border-radius: 8px;
      background: rgba(105, 185, 255, .09);
      color: #dceeff;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.45;
    }
    .polytrack-cheat-replay-status[hidden] { display: none; }
    .polytrack-cheat-row input {
      display: block;
      width: 100%;
      margin: 13px 0 0;
      accent-color: #69b9ff;
      cursor: pointer;
    }
    .polytrack-cheat-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-top: 19px;
    }
    .polytrack-cheat-reset { padding: 9px 13px; }
    .polytrack-cheat-reset:disabled { opacity: .45; cursor: not-allowed; }
    .polytrack-cheat-close:hover,
    .polytrack-cheat-reset:hover,
    #polytrack-cheat-launcher:hover { background: rgba(255, 255, 255, .15); }
    #polytrack-cheat-launcher {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 9999;
      padding: 10px 15px;
      border-color: rgba(117, 184, 255, .6);
      background: rgba(14, 29, 49, .94);
      box-shadow: 0 8px 28px rgba(0, 0, 0, .3);
      font: 14px/1.2 system-ui, sans-serif;
    }
    #polytrack-name-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10001;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(3, 7, 15, .82);
      color: #f3f6fc;
      font: 15px/1.45 system-ui, sans-serif;
    }
    #polytrack-profile-backup-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10002;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(3, 7, 15, .82);
      color: #f3f6fc;
      font: 15px/1.45 system-ui, sans-serif;
    }
    #polytrack-profile-backup-backdrop[hidden] { display: none !important; }
    #polytrack-profile-backup-dialog {
      width: min(500px, 100%);
      max-height: min(90vh, 700px);
      overflow: auto;
      box-sizing: border-box;
      padding: 24px;
      border: 1px solid rgba(151, 181, 229, .42);
      border-radius: 12px;
      background: linear-gradient(155deg, #18243a, #0b111f 74%);
      box-shadow: 0 24px 80px rgba(0, 0, 0, .56);
      text-align: left;
    }
    #polytrack-profile-backup-dialog * { box-sizing: border-box; }
    .polytrack-profile-backup-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 12px;
    }
    #polytrack-profile-backup-dialog h2 {
      margin: 0;
      color: #fff;
      font-size: 24px;
      line-height: 1.2;
    }
    #polytrack-profile-backup-dialog p {
      margin: 0 0 14px;
      color: #aab7ca;
      font-size: 13px;
    }
    #polytrack-profile-backup-dialog .polytrack-profile-warning {
      padding: 11px 13px;
      border: 1px solid rgba(255, 190, 91, .35);
      border-radius: 8px;
      background: rgba(255, 190, 91, .08);
      color: #ffe2ae;
    }
    #polytrack-profile-backup-dialog .polytrack-profile-backup-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 18px 0 12px;
    }
    #polytrack-profile-backup-dialog button {
      min-height: 42px;
      padding: 9px 14px;
      border: 1px solid rgba(178, 198, 230, .35);
      border-radius: 7px;
      background: rgba(255, 255, 255, .08);
      color: #f3f6fc;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    #polytrack-profile-backup-dialog button:hover {
      background: rgba(255, 255, 255, .15);
    }
    #polytrack-profile-backup-dialog button:focus-visible {
      outline: 2px solid #69b9ff;
      outline-offset: 2px;
    }
    #polytrack-profile-backup-dialog button:disabled {
      opacity: .55;
      cursor: wait;
    }
    #polytrack-profile-backup-close {
      flex: 0 0 auto;
      width: 36px;
      padding: 0 !important;
      font-size: 22px !important;
      line-height: 1;
    }
    #polytrack-profile-backup-status {
      min-height: 20px;
      margin: 10px 0 0 !important;
      color: #aab7ca !important;
    }
    #polytrack-profile-backup-status.success { color: #a9e5b1 !important; }
    #polytrack-profile-backup-status.error { color: #ffb5b5 !important; }
    #polytrack-name-backdrop[hidden] { display: none !important; }
    #polytrack-name-dialog {
      width: min(420px, 100%);
      padding: 24px;
      border: 1px solid rgba(151, 181, 229, .42);
      border-radius: 12px;
      background: linear-gradient(155deg, #18243a, #0b111f 74%);
      box-shadow: 0 24px 80px rgba(0, 0, 0, .56);
    }
    #polytrack-name-dialog h2 {
      margin: 0 0 8px;
      color: #fff;
      font-size: 23px;
      line-height: 1.2;
    }
    #polytrack-name-dialog p {
      margin: 0 0 16px;
      color: #aab7ca;
      font-size: 13px;
    }
    #polytrack-name-input {
      display: block;
      width: 100%;
      min-height: 44px;
      margin: 0 0 14px;
      padding: 10px 12px;
      border: 1px solid rgba(178, 198, 230, .35);
      border-radius: 7px;
      background: rgba(255, 255, 255, .08);
      color: #fff;
      font: inherit;
    }
    #polytrack-name-input:focus {
      outline: 2px solid #69b9ff;
      outline-offset: 2px;
    }
    #polytrack-name-dialog #polytrack-name-status {
      min-height: 20px;
      margin: 0 0 12px;
      color: #ffb5b5;
    }
    #polytrack-name-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    #polytrack-name-actions button {
      min-height: 40px;
      padding: 8px 14px;
      border: 1px solid rgba(178, 198, 230, .35);
      border-radius: 7px;
      background: rgba(255, 255, 255, .08);
      color: #f3f6fc;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    #polytrack-name-save {
      border-color: rgba(117, 184, 255, .65) !important;
      background: #235c91 !important;
    }
    #polytrack-name-actions button:disabled {
      opacity: .55;
      cursor: wait;
    }
    #polytrack-weekly-status {
      position: fixed;
      z-index: 10000;
      left: 50%;
      bottom: max(12px, env(safe-area-inset-bottom));
      display: flex;
      align-items: center;
      gap: 12px;
      width: max-content;
      max-width: calc(100vw - 24px);
      padding: 10px 12px;
      transform: translateX(-50%);
      border: 1px solid rgba(255, 181, 181, .6);
      border-radius: 8px;
      background: rgba(28, 20, 24, .96);
      color: #fff;
      font: 14px/1.35 system-ui, sans-serif;
      box-shadow: 0 4px 18px rgba(0, 0, 0, .45);
      pointer-events: none;
    }
    #polytrack-weekly-status button {
      flex: 0 0 auto;
      min-height: 34px;
      padding: 6px 10px;
      border: 1px solid rgba(178, 198, 230, .55);
      border-radius: 6px;
      background: #235c91;
      color: #fff;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      pointer-events: auto;
    }
    #polytrack-weekly-status button:disabled {
      opacity: .65;
      cursor: wait;
    }
    .track-selection-ui .track-of-the-week-no-track {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 256px;
      color: var(--text-color);
      font-size: 24px;
      text-align: center;
      white-space: pre-wrap;
    }
    .track-selection-ui .track.track-of-the-week {
      display: block;
    }
    .track-selection-ui .track.track-of-the-week > .button {
      display: flex;
      align-items: stretch;
      width: 100%;
      padding: 0;
      text-align: left;
    }
    .track-selection-ui .track.track-of-the-week > .button > .thumbnail-background {
      position: absolute;
      width: 512px;
      height: 256px;
      background-color: rgba(0, 0, 0, .12);
      pointer-events: none;
    }
    .track-selection-ui .track.track-of-the-week > .button > .thumbnail {
      flex-shrink: 0;
      width: 512px;
      height: 256px;
      padding: 40px;
      box-sizing: border-box;
      object-fit: contain;
      pointer-events: none;
    }
    .track-selection-ui .track.track-of-the-week > .button > .track-of-the-week-info {
      display: flex;
      flex-direction: column;
      justify-content: center;
      flex-grow: 1;
      min-width: 0;
      padding: 30px 40px;
      text-align: left;
    }
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .title,
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .author,
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .date-range,
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .time-remaining {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .title {
      font-size: 48px;
    }
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .author {
      font-size: 20px;
      opacity: .5;
    }
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .date-range {
      margin-top: 4px;
      font-size: 16px;
      opacity: .7;
    }
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .time-remaining {
      margin-top: 25px;
      font-size: 28px;
    }
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .time-remaining.ending-soon {
      color: #f55;
    }
    .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .personal-best {
      margin-top: 16px;
      font-size: 20px;
      opacity: .8;
    }
    .track-selection-ui .track.track-of-the-week .weekly-first-place {
      margin-top: 8px;
      overflow: hidden;
      font-size: 18px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .track-selection-ui .track.track-of-the-week .personal-best img {
      width: 24px;
      height: 24px;
      margin-right: 8px;
      vertical-align: middle;
    }
    @media (max-width: 760px) {
      .track-selection-ui .track.track-of-the-week > .button {
        flex-direction: column;
      }
      .track-selection-ui .track.track-of-the-week > .button > .thumbnail,
      .track-selection-ui .track.track-of-the-week > .button > .thumbnail-background {
        width: 100%;
        height: 220px;
      }
      .track-selection-ui .track.track-of-the-week > .button > .thumbnail {
        padding: 24px;
      }
      .track-selection-ui .track.track-of-the-week > .button > .track-of-the-week-info {
        padding: 20px 24px;
      }
      .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .title {
        font-size: clamp(28px, 7vw, 40px);
      }
      .track-selection-ui .track.track-of-the-week .track-of-the-week-info > .time-remaining {
        margin-top: 14px;
        font-size: 22px;
      }
    }
    @media (max-width: 480px) {
      #polytrack-cheat-panel { padding: 19px; }
      #polytrack-cheat-launcher { right: 12px; bottom: 12px; }
      #polytrack-name-dialog { padding: 20px; }
    }
    .button.polytrack-delete-pb {
      color: #fff !important;
      background-color: #923b4d !important;
      font: 600 14px/1.2 system-ui, sans-serif !important;
      text-transform: none !important;
    }
    .button.polytrack-delete-pb:hover {
      background-color: #b4465a !important;
    }
    #ui > .debug-ui {
      position: fixed !important;
      top: 8px !important;
      left: 8px !important;
      bottom: auto !important;
      right: auto !important;
      z-index: 9999 !important;
      translate: 0 calc(var(--polytrack-fps-top, 8px) - 8px) !important;
      transition: translate 150ms ease-out;
      will-change: translate;
    }
    @media (prefers-reduced-motion: reduce) {
      #ui > .debug-ui {
        transition-duration: 0s !important;
      }
    }
  `;
  document.head.appendChild(style);

  function syncBuiltinFpsCounterPosition() {
    const counter = document.querySelector?.("#ui > .debug-ui");
    if (
      !counter?.style ||
      typeof counter.style.setProperty !== "function" ||
      typeof document.querySelectorAll !== "function"
    ) return;

    const viewportWidth =
      window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight =
      window.innerHeight || document.documentElement?.clientHeight || 0;
    const counterRect = counter.getBoundingClientRect?.();
    const counterWidth = counterRect?.width || counter.offsetWidth || 0;
    const counterHeight = counterRect?.height || counter.offsetHeight || 0;
    if (
      viewportWidth <= 0 ||
      viewportHeight <= 0 ||
      counterWidth <= 0 ||
      counterHeight <= 0
    ) return;

    const leftInset = 8;
    const leftEdge = leftInset;
    const rightEdge = leftInset + counterWidth;
    const uiElements = document.querySelectorAll("#ui *");
    const visibilityCache = new Map();
    const isVisible = (element) => {
      if (!element) return true;
      if (visibilityCache.has(element)) return visibilityCache.get(element);
      const computed = typeof window.getComputedStyle === "function"
        ? window.getComputedStyle(element)
        : null;
      const visible = !element.hidden &&
        computed?.display !== "none" &&
        computed?.visibility !== "hidden" &&
        computed?.visibility !== "collapse" &&
        Number.parseFloat(computed?.opacity ?? "1") > 0 &&
        isVisible(element.parentElement);
      visibilityCache.set(element, visible);
      return visible;
    };
    let top = 8;
    const collisionGap = 20;
    const maxTop = Math.max(
      8,
      Math.min(viewportHeight - counterHeight - 8, 160),
    );

    const blockers = [];
    for (const control of uiElements) {
      if (control === counter || counter.contains?.(control)) continue;
      const rect = control.getBoundingClientRect?.();
      if (
        !rect ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.width > viewportWidth * 0.9 ||
        rect.height > viewportHeight * 0.45 ||
        rect.right <= leftEdge ||
        rect.left >= rightEdge ||
        rect.bottom + collisionGap <= top ||
        rect.top >= maxTop + counterHeight + collisionGap ||
        !isVisible(control)
      ) continue;
      blockers.push(rect);
    }
    blockers.sort((a, b) => a.top - b.top);
    for (const rect of blockers) {
      if (rect.top >= top + counterHeight + collisionGap) break;
      if (rect.bottom + collisionGap > top) {
        top = Math.min(maxTop, rect.bottom + collisionGap);
      }
      if (top >= maxTop) break;
    }

    const nextPosition = `${Math.min(Math.ceil(top), maxTop)}px`;
    if (
      counter.style.getPropertyValue("--polytrack-fps-top") !== nextPosition
    ) {
      counter.style.setProperty("--polytrack-fps-top", nextPosition);
    }
  }

  function observeBuiltinFpsCounterPosition() {
    let updateScheduled = false;
    const scheduleUpdate = () => {
      if (updateScheduled) return;
      updateScheduled = true;
      const update = () => {
        updateScheduled = false;
        syncBuiltinFpsCounterPosition();
      };
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(update);
      } else {
        setTimeout(update, 0);
      }
    };

    const root =
      document.querySelector?.("#ui") ||
      document.body ||
      document.documentElement;
    if (root && typeof window.MutationObserver === "function") {
      const controlsSelector = "button, a, input, select, textarea, [role='button'], .button";
      const containsControls = (node) => node?.nodeType === 1 &&
        (node.matches?.(controlsSelector) || node.querySelector?.(controlsSelector));
      const observer = new window.MutationObserver((mutations) => {
        const counter = document.querySelector?.("#ui > .debug-ui");
        if (mutations.some(({
          type,
          target,
          attributeName,
          oldValue,
          addedNodes,
          removedNodes,
        }) => {
          if (target === counter || counter?.contains?.(target)) return false;
          if (type === "attributes") {
            // The game writes the same control classes every render frame.
            // Ignore no-op writes so they do not trigger layout measurements.
            return oldValue !== target.getAttribute?.(attributeName);
          }
          if (type !== "childList") return false;
          if (target === root) return true;
          // HUD timers and speeds replace text nodes while driving. Those
          // updates must not run collision detection on every game frame.
          return Array.from(addedNodes || []).some(containsControls) ||
            Array.from(removedNodes || []).some(containsControls);
        })) {
          scheduleUpdate();
        }
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: [
          "class",
          "hidden",
          "aria-hidden",
          "aria-expanded",
          "data-state",
        ],
      });
    }
    window.addEventListener("resize", scheduleUpdate);
    let scrollUpdateTimer = null;
    document.addEventListener("scroll", () => {
      if (scrollUpdateTimer !== null) return;
      scrollUpdateTimer = setTimeout(() => {
        scrollUpdateTimer = null;
        scheduleUpdate();
      }, 100);
    }, true);
    document.addEventListener("transitionend", scheduleUpdate, true);
    document.addEventListener("animationend", scheduleUpdate, true);
    scheduleUpdate();
  }

  function turnOnBuiltinFpsCounterByDefault() {
    let retriesRemaining = 120;
    let positionObserverStarted = false;
    const counterIsVisible = () =>
      typeof document.querySelector === "function" &&
      Boolean(document.querySelector("#ui > .debug-ui"));
    const startPositionObserver = () => {
      if (positionObserverStarted) return;
      positionObserverStarted = true;
      observeBuiltinFpsCounterPosition();
    };

    const tryTurningCounterOn = () => {
      if (counterIsVisible()) {
        startPositionObserver();
        return;
      }
      if (typeof document.dispatchEvent !== "function" ||
          typeof window.KeyboardEvent !== "function") return;
      for (const type of ["keydown", "keyup"]) {
        document.dispatchEvent(new window.KeyboardEvent(type, {
          key: "=",
          code: "Equal",
          bubbles: true,
          cancelable: true,
        }));
      }
      if (counterIsVisible()) {
        startPositionObserver();
        return;
      }
      if (retriesRemaining <= 0) return;
      retriesRemaining -= 1;
      setTimeout(tryTurningCounterOn, 500);
    };
    const afterGameInitialization = () => setTimeout(tryTurningCounterOn, 0);
    if (document.readyState === "loading" || document.readyState === "interactive") {
      document.addEventListener("DOMContentLoaded", afterGameInitialization, { once: true });
    } else {
      afterGameInitialization();
    }
  }
  turnOnBuiltinFpsCounterByDefault();

  function getMondayKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const monday = new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    ));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }

  function selectWeeklyCommunityTrack(entries, value = new Date()) {
    if (!Array.isArray(entries)) return null;
    const uniqueTracks = new Map();
    for (const entry of entries) {
      if (
        entry &&
        typeof entry.id === "string" &&
        /^[a-f0-9]{64}$/i.test(entry.id) &&
        typeof entry.name === "string" &&
        entry.name.trim()
      ) {
        uniqueTracks.set(entry.id.toLowerCase(), entry);
      }
    }
    const tracks = [...uniqueTracks.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (tracks.length === 0) return null;

    const ids = tracks.map(({ id }) => id.toLowerCase()).join(",");
    const currentWeek = getMondayKey(value);
    if (!currentWeek) return null;
    let seed = 2166136261;
    for (const character of ids) {
      seed ^= character.charCodeAt(0);
      seed = Math.imul(seed, 16777619);
    }
    if (seed === 0) seed = 0x9e3779b9;
    const nextRandom = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = seed;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const shuffledTracks = [...tracks];
    for (let index = shuffledTracks.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(nextRandom() * (index + 1));
      [shuffledTracks[index], shuffledTracks[swapIndex]] = [
        shuffledTracks[swapIndex],
        shuffledTracks[index],
      ];
    }
    const weekNumber = Math.floor(
      (Date.parse(`${currentWeek}T00:00:00.000Z`) - Date.UTC(1970, 0, 5)) /
        (7 * 24 * 60 * 60 * 1000),
    );
    const selectedIndex =
      ((weekNumber % shuffledTracks.length) + shuffledTracks.length) %
      shuffledTracks.length;

    return { ...shuffledTracks[selectedIndex], weekStart: currentWeek };
  }

  window.__polytrackSelectWeeklyTrack = selectWeeklyCommunityTrack;

  let weeklyApiTrack = null;
  let weeklyApiStatus = "loading";
  let weeklyStatusElement = null;
  let weeklyRetryButton = null;
  let weeklyRequestInProgress = false;
  let weeklyTrackRefreshTimeout = null;
  window.__polytrackWeeklyTrackStatus = weeklyApiStatus;

  const weeklyTrackDuration = 7 * 24 * 60 * 60 * 1000;
  const weeklyApiRequestTimeoutMs = 10_000;
  let featuredTrackHeading = null;
  let featuredTrackCard = null;
  let featuredTrackContainer = null;
  let featuredTrackEndTime = 0;
  let featuredTimeRemaining = null;
  let featuredRecordValue = null;
  let featuredLeaderValue = null;
  let featuredLeaderAbortController = null;
  let featuredLeaderRefreshInterval = null;
  let featuredLeaderRequestId = 0;
  let featuredTrackId = "";
  let featuredTrackWeek = "";
  let observedCommunityTrackTab = null;

  function getWeeklyTrackEndTime(track) {
    const apiEndTime = Date.parse(track?.endTime);
    if (Number.isFinite(apiEndTime)) return apiEndTime;
    const weekStartTime = Date.parse(`${track?.weekStart}T00:00:00.000Z`);
    return Number.isFinite(weekStartTime)
      ? weekStartTime + weeklyTrackDuration
      : NaN;
  }

  function refreshWeeklyTrackIfExpired() {
    if (weeklyRequestInProgress || !weeklyApiTrack) return;
    const endTime = getWeeklyTrackEndTime(weeklyApiTrack);
    if (Number.isFinite(endTime) && Date.now() >= endTime) {
      void loadWeeklyTrack();
    }
  }

  function scheduleWeeklyTrackRefresh() {
    if (weeklyTrackRefreshTimeout !== null) {
      window.clearTimeout(weeklyTrackRefreshTimeout);
      weeklyTrackRefreshTimeout = null;
    }
    const endTime = getWeeklyTrackEndTime(weeklyApiTrack);
    if (!Number.isFinite(endTime)) return;

    const delay = Math.max(0, endTime - Date.now());
    weeklyTrackRefreshTimeout = window.setTimeout(() => {
      weeklyTrackRefreshTimeout = null;
      if (weeklyRequestInProgress || !weeklyApiTrack) return;
      const currentEndTime = getWeeklyTrackEndTime(weeklyApiTrack);
      if (!Number.isFinite(currentEndTime)) return;
      if (Date.now() >= currentEndTime) refreshWeeklyTrackIfExpired();
      else scheduleWeeklyTrackRefresh();
    }, Math.min(delay, 2_147_483_647));
  }

  function findCommunityTrackButton(selected, container) {
    if (typeof container.querySelectorAll !== "function") return null;
    const titleElements = container.querySelectorAll(
      ".track:not(.track-of-the-week) .track-title > p",
    );
    let titleFallback = null;
    for (const titleElement of titleElements) {
      const button = titleElement.parentElement?.parentElement;
      if (!button || typeof button.querySelectorAll !== "function") continue;
      const thumbnailMatches = [...button.querySelectorAll("img")].some((image) =>
        (image.getAttribute("src") || image.src || "").includes(selected.thumbnail),
      );
      if (thumbnailMatches) return button;
      if (
        !titleFallback &&
        titleElement.textContent?.trim() === selected.name.trim()
      ) {
        titleFallback = button;
      }
    }
    return titleFallback;
  }

  function formatWeeklyCountdown(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds - 86400 * days) / 3600);
    const minutes = Math.floor((seconds - 86400 * days - 3600 * hours) / 60);
    const remainingSeconds = seconds - 86400 * days - 3600 * hours - 60 * minutes;
    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m ${remainingSeconds}s`;
    }
    if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
    if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
    return `${remainingSeconds}s`;
  }

  function updateWeeklyTrackCardWidth() {
    const parent = featuredTrackCard?.parentElement;
    if (!parent || !featuredTrackCard) return;
    const parentWidth = parent.clientWidth;
    if (!Number.isFinite(parentWidth) || parentWidth <= 0) return;
    const width = Math.max(236, Math.floor(parentWidth / 236) * 236);
    featuredTrackCard.style.width = `${width}px`;
  }

  function updateWeeklyTrackCountdown() {
    if (!featuredTimeRemaining || !featuredTrackEndTime) return;
    const seconds = Math.max(
      0,
      Math.floor((featuredTrackEndTime - Date.now()) / 1000),
    );
    const countdown = formatWeeklyCountdown(seconds);
    if (featuredTimeRemaining.textContent !== countdown) {
      featuredTimeRemaining.textContent = countdown;
    }
    if (seconds <= 6 * 60 * 60) {
      featuredTimeRemaining.classList.add("ending-soon");
    } else {
      featuredTimeRemaining.classList.remove("ending-soon");
    }
  }

  function loadFeaturedTrackLeader(trackId, weekStart) {
    const value = featuredLeaderValue;
    if (!value) return;

    featuredLeaderAbortController?.abort();
    const controller = new AbortController();
    featuredLeaderAbortController = controller;
    const requestId = ++featuredLeaderRequestId;
    const previousValue = value.textContent;
    const hasPreviousResult = previousValue !== "" &&
      previousValue !== "1st place: Loading…" &&
      previousValue !== "1st place: Unavailable";
    if (!hasPreviousResult) value.textContent = "1st place: Loading…";

    const query = new URLSearchParams({
      version: "v6",
      trackId,
      skip: "0",
      amount: "1",
      onlyVerified: "true",
    });
    let requestTimeout = null;
    const request = (async () => {
      const response = await fetch(`/api/v6/leaderboard?${query}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Featured track leaderboard failed with ${response.status}`);
      }
      const result = await response.json();
      if (!Array.isArray(result?.entries)) {
        throw new Error("Featured track leaderboard response was invalid");
      }
      return result.entries[0] || null;
    })();
    const timeout = new Promise((_, reject) => {
      requestTimeout = window.setTimeout(() => {
        controller.abort();
        reject(new Error("Featured track leaderboard request timed out"));
      }, weeklyApiRequestTimeoutMs);
    });
    const isCurrentRequest = () =>
      requestId === featuredLeaderRequestId &&
      featuredTrackId === trackId &&
      featuredTrackWeek === weekStart &&
      featuredLeaderValue === value;

    Promise.race([request, timeout])
      .then((leader) => {
        if (!isCurrentRequest()) return;
        if (!leader) {
          value.textContent = "1st place: No times yet";
          return;
        }
        const nickname = typeof leader.nickname === "string" && leader.nickname.trim()
          ? leader.nickname.trim()
          : "Unknown driver";
        value.textContent = `1st place: ${nickname}`;
      })
      .catch(() => {
        if (isCurrentRequest() && !hasPreviousResult) {
          value.textContent = "1st place: Unavailable";
        }
      })
      .finally(() => {
        if (requestTimeout !== null) window.clearTimeout(requestTimeout);
        if (featuredLeaderAbortController === controller) {
          featuredLeaderAbortController = null;
        }
      });
  }

  function refreshFeaturedLeaderIfVisible() {
    if (
      document.visibilityState === "hidden" ||
      !featuredTrackId ||
      !featuredLeaderValue ||
      !featuredTrackContainer?.classList.contains("open") ||
      !observedCommunityTrackTab?.classList.contains("selected")
    ) return;
    loadFeaturedTrackLeader(featuredTrackId, featuredTrackWeek);
  }

  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshFeaturedLeaderIfVisible();
    });
  }

  function removeWeeklyTrackSection() {
    featuredLeaderRequestId += 1;
    featuredLeaderAbortController?.abort();
    featuredLeaderAbortController = null;
    if (featuredLeaderRefreshInterval !== null) {
      window.clearInterval(featuredLeaderRefreshInterval);
      featuredLeaderRefreshInterval = null;
    }
    for (const element of [featuredTrackHeading, featuredTrackCard]) {
      if (element?.parentElement) element.parentElement.removeChild(element);
    }
    featuredTrackHeading = null;
    featuredTrackCard = null;
    featuredTrackContainer = null;
    featuredTrackEndTime = 0;
    featuredTimeRemaining = null;
    featuredRecordValue = null;
    featuredLeaderValue = null;
    featuredTrackId = "";
    featuredTrackWeek = "";
  }

  function updateWeeklyTrackSection() {
    const selected = weeklyApiStatus === "available" ? weeklyApiTrack : null;
    window.__polytrackCurrentWeeklyTrack = selected;
    if (weeklyApiStatus === "loading") {
      removeWeeklyTrackSection();
      return;
    }
    if (
      typeof document.querySelector !== "function" ||
      typeof document.querySelectorAll !== "function"
    ) return;
    const communityTab = document.querySelector(
      ".track-selection-ui .category-container > .button.community",
    );
    if (communityTab && communityTab !== observedCommunityTrackTab) {
      observedCommunityTrackTab = communityTab;
      communityTab.addEventListener("click", () => {
        window.setTimeout(updateWeeklyTrackSection, 0);
      });
    }
    const container = communityTab?.classList.contains("selected")
      ? document.querySelector(".track-selection-ui .tracks-container.open")
      : null;
    if (!container) return;

    if (!selected) {
      if (
        featuredTrackId === "" &&
        featuredTrackContainer === container &&
        featuredTrackHeading?.parentElement === container
      ) return;
      removeWeeklyTrackSection();
      const heading = document.createElement("div");
      heading.className = "group-title";
      heading.textContent = "Track of the Week";
      const emptyState = document.createElement("div");
      emptyState.className = "track-of-the-week-no-track";
      emptyState.textContent =
        "There is currently no Track of the Week.\nPlease check again later.";
      const before = container.firstChild;
      container.insertBefore(heading, before);
      container.insertBefore(emptyState, before);
      featuredTrackHeading = heading;
      featuredTrackCard = emptyState;
      featuredTrackContainer = container;
      return;
    }

    if (
      selected.id === featuredTrackId &&
      selected.weekStart === featuredTrackWeek &&
      featuredTrackContainer === container &&
      featuredTrackHeading?.parentElement === container &&
      featuredTrackCard?.parentElement === container
    ) {
      const mapButton = findCommunityTrackButton(selected, container);
      const record = mapButton?.querySelector(".record")?.textContent?.trim();
      if (
        featuredRecordValue &&
        record &&
        featuredRecordValue.textContent !== record
      ) {
        featuredRecordValue.textContent = record;
      }
      updateWeeklyTrackCardWidth();
      updateWeeklyTrackCountdown();
      return;
    }

    removeWeeklyTrackSection();
    const weekStartTime = Date.parse(`${selected.weekStart}T00:00:00.000Z`);
    if (!Number.isFinite(weekStartTime)) return;
    const weekEndTime = getWeeklyTrackEndTime(selected);

    const heading = document.createElement("div");
    heading.className = "group-title";
    heading.textContent = "Track of the Week";
    heading.setAttribute("data-polytrack-weekly-heading", "true");

    const card = document.createElement("div");
    card.className = "track track-of-the-week";
    card.setAttribute("data-polytrack-weekly-track", selected.id);
    card.setAttribute("data-polytrack-weekly-week", selected.weekStart);

    const button = document.createElement("button");
    button.className = "button";
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", `Track of the Week: ${selected.name}`);
    button.addEventListener("click", () => {
      findCommunityTrackButton(selected, container)?.click();
    });
    card.appendChild(button);

    const thumbnailBackground = document.createElement("div");
    thumbnailBackground.className = "thumbnail-background";
    button.appendChild(thumbnailBackground);

    const thumbnail = document.createElement("img");
    thumbnail.className = "thumbnail";
    thumbnail.loading = "lazy";
    thumbnail.alt = selected.name;
    thumbnail.src = selected.thumbnail;
    button.appendChild(thumbnail);

    const info = document.createElement("div");
    info.className = "track-of-the-week-info";
    button.appendChild(info);

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = selected.name;
    info.appendChild(title);

    if (selected.author) {
      const author = document.createElement("div");
      author.className = "author";
      author.textContent = `By ${selected.author}`;
      info.appendChild(author);
    }

    const timeRemaining = document.createElement("div");
    timeRemaining.className = "time-remaining";
    info.appendChild(timeRemaining);

    const startDate = new Date(weekStartTime);
    const endDate = new Date(weekEndTime);
    const dateRange = document.createElement("div");
    dateRange.className = "date-range";
    dateRange.textContent =
      `${startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ` +
      `${endDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ` +
      endDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    info.appendChild(dateRange);

    const personalBest = document.createElement("div");
    personalBest.className = "personal-best";
    const personalBestContents = document.createElement("div");
    const timerIcon = document.createElement("img");
    timerIcon.src = "images/timer.svg";
    timerIcon.alt = "";
    personalBestContents.appendChild(timerIcon);
    const recordValue = document.createElement("span");
    const mapButton = findCommunityTrackButton(selected, container);
    recordValue.textContent =
      mapButton?.querySelector(".record")?.textContent?.trim() || "No record";
    personalBestContents.appendChild(recordValue);
    personalBest.appendChild(personalBestContents);
    info.appendChild(personalBest);

    const firstPlace = document.createElement("div");
    firstPlace.className = "weekly-first-place";
    firstPlace.id = "polytrack-weekly-first-place";
    firstPlace.setAttribute("data-polytrack-weekly-first-place", "true");
    firstPlace.setAttribute("role", "status");
    firstPlace.setAttribute("aria-live", "polite");
    firstPlace.textContent = "1st place: Loading…";
    button.setAttribute("aria-describedby", firstPlace.id);
    info.appendChild(firstPlace);

    const before = container.firstChild;
    container.insertBefore(heading, before);
    container.insertBefore(card, before);
    featuredTrackHeading = heading;
    featuredTrackCard = card;
    featuredTrackContainer = container;
    featuredTrackEndTime = weekEndTime;
    featuredTimeRemaining = timeRemaining;
    featuredRecordValue = recordValue;
    featuredLeaderValue = firstPlace;
    featuredTrackId = selected.id;
    featuredTrackWeek = selected.weekStart;
    updateWeeklyTrackCardWidth();
    updateWeeklyTrackCountdown();
    loadFeaturedTrackLeader(selected.id, selected.weekStart);
    featuredLeaderRefreshInterval = window.setInterval(
      refreshFeaturedLeaderIfVisible,
      60_000,
    );
  }

  function showWeeklyTrackError() {
    if (!weeklyStatusElement) {
      weeklyStatusElement = document.createElement("div");
      weeklyStatusElement.id = "polytrack-weekly-status";
      weeklyStatusElement.setAttribute("role", "status");
      weeklyStatusElement.setAttribute("aria-live", "polite");

      const message = document.createElement("span");
      message.textContent =
        "Track of the Week is unavailable. Regular tracks are still available.";
      weeklyStatusElement.appendChild(message);

      weeklyRetryButton = document.createElement("button");
      weeklyRetryButton.type = "button";
      weeklyRetryButton.textContent = "Retry";
      weeklyRetryButton.setAttribute("aria-label", "Retry Track of the Week");
      weeklyRetryButton.addEventListener("click", () => {
        void loadWeeklyTrack();
      });
      weeklyStatusElement.appendChild(weeklyRetryButton);
      document.body.appendChild(weeklyStatusElement);
    }
    weeklyRetryButton.disabled = weeklyRequestInProgress;
    weeklyRetryButton.textContent = weeklyRequestInProgress ? "Retrying…" : "Retry";
  }

  async function loadWeeklyTrack() {
    if (weeklyRequestInProgress) return;
    if (weeklyTrackRefreshTimeout !== null) {
      window.clearTimeout(weeklyTrackRefreshTimeout);
      weeklyTrackRefreshTimeout = null;
    }
    weeklyRequestInProgress = true;
    if (weeklyRetryButton) {
      weeklyRetryButton.disabled = true;
      weeklyRetryButton.textContent = "Retrying…";
    }

    const controller = new AbortController();
    let requestTimeout = null;
    try {
      const request = (async () => {
        const response = await fetch("/api/v6/trackOfTheWeek?version=0.6.3", {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `Track of the Week request failed with ${response.status}`,
          );
        }
        const result = await response.json();
        const current = result?.current;
        const weekStart = getMondayKey(result?.serverTime);
        if (
          typeof current?.trackId !== "string" ||
          typeof current?.name !== "string" ||
          typeof current?.thumbnailUrl !== "string" ||
          !weekStart
        ) {
          throw new Error("Track of the Week response was invalid");
        }

        return {
          id: current.trackId,
          name: current.name,
          author: current.author,
          thumbnail: current.thumbnailUrl,
          endTime: current.endTime,
          weekStart,
        };
      })();
      const track = await Promise.race([
        request,
        new Promise((_, reject) => {
          requestTimeout = window.setTimeout(() => {
            reject(new Error("Track of the Week request timed out"));
            controller.abort();
          }, weeklyApiRequestTimeoutMs);
        }),
      ]);

      weeklyApiTrack = track;
      weeklyApiStatus = "available";
      window.__polytrackWeeklyTrackStatus = weeklyApiStatus;
      updateWeeklyTrackSection();
      scheduleWeeklyTrackRefresh();
      weeklyStatusElement?.remove();
      weeklyStatusElement = null;
      weeklyRetryButton = null;
    } catch {
      weeklyApiTrack = null;
      weeklyApiStatus = "unavailable";
      window.__polytrackWeeklyTrackStatus = weeklyApiStatus;
      updateWeeklyTrackSection();
      showWeeklyTrackError();
    } finally {
      if (requestTimeout !== null) {
        window.clearTimeout(requestTimeout);
      }
      weeklyRequestInProgress = false;
      if (weeklyRetryButton) {
        weeklyRetryButton.disabled = false;
        weeklyRetryButton.textContent = "Retry";
      }
    }
  }

  if (
    typeof window.MutationObserver === "function" &&
    document.body &&
    typeof document.querySelectorAll === "function"
  ) {
    const weeklyTrackObserver = new window.MutationObserver(
      updateWeeklyTrackSection,
    );
    weeklyTrackObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    updateWeeklyTrackSection();
    window.addEventListener("resize", updateWeeklyTrackCardWidth);
    window.addEventListener("focus", refreshWeeklyTrackIfExpired);
    window.addEventListener("pageshow", refreshWeeklyTrackIfExpired);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshWeeklyTrackIfExpired();
      }
    });
    setInterval(() => {
      refreshWeeklyTrackIfExpired();
      updateWeeklyTrackCountdown();
    }, 1000);
  }

  void loadWeeklyTrack();

  function toast(message) {
    let element = document.getElementById("site-feature-toast");
    if (!element) {
      element = document.createElement("div");
      element.id = "site-feature-toast";
      document.body.appendChild(element);
    }
    element.textContent = message;
    element.classList.add("visible");
    clearTimeout(toast.timeout);
    toast.timeout = setTimeout(() => element.classList.remove("visible"), 3000);
  }

  function closeCheatMenu() {
    if (cheatMenu) {
      cheatMenu.hidden = true;
      updateCheatReplayIndicator();
      if (cheatMenuAvailable && !cheatLauncher?.hidden) cheatLauncher?.focus();
    }
  }

  function openCheatMenu() {
    if (!cheatMenuAvailable) return;
    if (!cheatMenu) createCheatMenu();
    cheatMenu.hidden = false;
    updateCheatReplayIndicator();
    cheatMenuCloseButton.focus();
  }

  function activateCheatMenu() {
    if (!cheatMenu) createCheatMenu();
    cheatMenuAvailable = true;
    cheatLauncher.hidden = false;
    openCheatMenu();
    clearTimeout(cheatMenuTimeout);
    cheatMenuTimeout = setTimeout(() => {
      cheatMenuAvailable = false;
      closeCheatMenu();
      cheatLauncher.hidden = true;
    }, cheatMenuDurationMs);
  }

  function createCheatMenu() {
    cheatMenu = document.createElement("div");
    cheatMenu.id = "polytrack-cheat-backdrop";
    cheatMenu.hidden = true;

    const panel = document.createElement("section");
    panel.id = "polytrack-cheat-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "polytrack-cheat-title");

    const header = document.createElement("header");
    header.className = "polytrack-cheat-header";
    const titleGroup = document.createElement("div");
    const kicker = document.createElement("p");
    kicker.className = "polytrack-cheat-kicker";
    kicker.textContent = "PLAYER SETTINGS";
    const title = document.createElement("h2");
    title.id = "polytrack-cheat-title";
    title.textContent = "我来同你玩！";
    titleGroup.appendChild(kicker);
    titleGroup.appendChild(title);

    cheatMenuCloseButton = document.createElement("button");
    cheatMenuCloseButton.id = "polytrack-cheat-close";
    cheatMenuCloseButton.className = "polytrack-cheat-close";
    cheatMenuCloseButton.type = "button";
    cheatMenuCloseButton.textContent = "×";
    cheatMenuCloseButton.setAttribute("aria-label", "Close cheat menu");
    cheatMenuCloseButton.addEventListener("click", closeCheatMenu);
    header.appendChild(titleGroup);
    header.appendChild(cheatMenuCloseButton);
    panel.appendChild(header);

    for (const setting of sliderSettings) {
      const row = document.createElement("label");
      row.className = "polytrack-cheat-row";
      const rowHead = document.createElement("span");
      rowHead.className = "polytrack-cheat-row-head";
      const label = document.createElement("span");
      label.textContent = setting.label;
      const value = document.createElement("output");
      value.className = "polytrack-cheat-value";
      value.textContent = `${Math.round(cheatSettings[setting.key] * 100)}%`;
      rowHead.appendChild(label);
      rowHead.appendChild(value);

      const description = document.createElement("span");
      description.className = "polytrack-cheat-description";
      description.textContent = setting.description;

      const input = document.createElement("input");
      input.id = `polytrack-cheat-${setting.key}`;
      input.type = "range";
      input.min = "0.9";
      input.max = "2";
      input.step = "0.01";
      input.value = String(cheatSettings[setting.key]);
      input.setAttribute("aria-label", setting.label);
      cheatControls.set(setting.key, { input, value });
      input.addEventListener("input", () => {
        cheatSettings[setting.key] = normalizeMultiplier(input.value, defaultCheatSettings[setting.key]);
        value.textContent = `${Math.round(cheatSettings[setting.key] * 100)}%`;
        publishCheatSettings();
      });

      row.appendChild(rowHead);
      row.appendChild(description);
      row.appendChild(input);
      panel.appendChild(row);
    }

    replayBoostStatusElement = document.createElement("p");
    replayBoostStatusElement.id = "polytrack-cheat-replay-status";
    replayBoostStatusElement.className = "polytrack-cheat-replay-status";
    replayBoostStatusElement.setAttribute("role", "status");
    replayBoostStatusElement.setAttribute("aria-live", "polite");
    replayBoostStatusElement.hidden = true;
    panel.appendChild(replayBoostStatusElement);

    const note = document.createElement("p");
    note.className = "polytrack-cheat-note";
    note.textContent =
      "Repair affects only the last opened local PB. Set its run's values; 100% restores normal physics.";
    replayRepairButton = document.createElement("button");
    replayRepairButton.id = "polytrack-cheat-repair-replay";
    replayRepairButton.className = "polytrack-cheat-reset";
    replayRepairButton.type = "button";
    replayRepairButton.textContent = "Repair last opened local PB";
    replayRepairButton.disabled = !lastReplayToRepair;
    replayRepairButton.addEventListener("click", () => {
      if (!lastReplayToRepair) return;
      const { key, recording } = lastReplayToRepair;
      const record = readJson(window.localStorage.getItem(key) || "");
      if (record?.recording !== recording) {
        toast("That record changed. Open it again.");
        lastReplayToRepair = null;
        replayRepairButton.disabled = true;
        return;
      }
      try {
        const settings = normalizeReplayBoostSettings(cheatSettings);
        delete record.replayBoostSettings;
        delete record.replayBoostTimeline;
        if (settings) record.replayBoostSettings = settings;
        repairingRecordKey = key;
        window.localStorage.setItem(key, JSON.stringify(record));
        repairingRecordKey = null;
        lastReplayToRepair = null;
        replayRepairButton.disabled = true;
        toast(settings
          ? "Saved. Restart it to apply the changes."
          : "Saved with normal physics. Restart it to apply the changes.");
      } catch {
        toast("Could not save the record.");
      } finally {
        if (repairingRecordKey === key) repairingRecordKey = null;
      }
    });
    const actions = document.createElement("div");
    actions.className = "polytrack-cheat-actions";
    const resetButton = document.createElement("button");
    resetButton.id = "polytrack-cheat-reset";
    resetButton.className = "polytrack-cheat-reset";
    resetButton.type = "button";
    resetButton.textContent = "Reset defaults";
    resetButton.addEventListener("click", () => {
      Object.assign(cheatSettings, defaultCheatSettings);
      for (const setting of sliderSettings) {
        const control = cheatControls.get(setting.key);
        if (!control) continue;
        control.input.value = String(cheatSettings[setting.key]);
        control.value.textContent = `${Math.round(cheatSettings[setting.key] * 100)}%`;
      }
      publishCheatSettings();
    });
    const hint = document.createElement("span");
    hint.className = "polytrack-cheat-note";
    hint.textContent = "Esc to close";
    actions.appendChild(resetButton);
    actions.appendChild(hint);
    panel.appendChild(note);
    panel.appendChild(replayRepairButton);
    panel.appendChild(actions);
    cheatMenu.appendChild(panel);

    cheatMenu.addEventListener("click", (event) => {
      if (event.target === cheatMenu) closeCheatMenu();
    });
    document.body.appendChild(cheatMenu);

    cheatLauncher = document.createElement("button");
    cheatLauncher.id = "polytrack-cheat-launcher";
    cheatLauncher.type = "button";
    cheatLauncher.textContent = "我来同你玩！";
    cheatLauncher.hidden = true;
    cheatLauncher.setAttribute("aria-label", "Open cheat menu");
    cheatLauncher.addEventListener("click", openCheatMenu);
    document.body.appendChild(cheatLauncher);
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && cheatMenu && !cheatMenu.hidden) {
      closeCheatMenu();
      return;
    }
    if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) {
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    typed = (typed + event.key.toLowerCase()).slice(-cheatCode.length);
    if (typed === cheatCode) {
      boostEnabled = true;
      publishCheatSettings();
      activateCheatMenu();
      toast("我来同你玩！");
      typed = "";
    }
  });

  function updateCheatReplayIndicator() {
    if (!replayBoostStatusElement) return;
    const isVisible = Boolean(
      activeReplayWatch && cheatMenuAvailable && cheatMenu && !cheatMenu.hidden
    );
    replayBoostStatusElement.hidden = !isVisible;
    if (!isVisible) return;

    const statuses = nativeWatchedReplayStatuses ?? Array.from(watchedReplayCarsByWorker.values())
      .flatMap((cars) => Array.from(cars.values()));
    if (statuses.length === 0) {
      replayBoostStatusElement.textContent = "Replay boost: checking replay data…";
      return;
    }

    const boostedCount = statuses.filter((status) => status === "boosted").length;
    const normalCount = statuses.filter((status) => status === "not-boosted").length;
    const unknownCount = statuses.length - boostedCount - normalCount;
    if (boostedCount === 0 && normalCount === 0) {
      replayBoostStatusElement.textContent =
        "Replay boost: UNKNOWN — this replay has no saved boost data.";
    } else if (statuses.length === 1 && boostedCount === 1) {
      replayBoostStatusElement.textContent = "Replay boost: BOOSTED";
    } else if (statuses.length === 1 && normalCount === 1) {
      replayBoostStatusElement.textContent = "Replay boost: NOT BOOSTED";
    } else if (boostedCount === statuses.length) {
      replayBoostStatusElement.textContent =
        `Replay boost: BOOSTED (${boostedCount} watched replays)`;
    } else if (normalCount === statuses.length) {
      replayBoostStatusElement.textContent =
        `Replay boost: NOT BOOSTED (${normalCount} watched replays)`;
    } else if (unknownCount === 0) {
      const summary = [];
      if (boostedCount > 0) summary.push(`${boostedCount} BOOSTED`);
      if (normalCount > 0) summary.push(`${normalCount} NOT BOOSTED`);
      replayBoostStatusElement.textContent = `Replay boost: ${summary.join("; ")}`;
    } else {
      const summary = [];
      if (boostedCount > 0) summary.push(`${boostedCount} BOOSTED`);
      if (normalCount > 0) summary.push(`${normalCount} NOT BOOSTED`);
      summary.push(`${unknownCount} UNKNOWN`);
      replayBoostStatusElement.textContent = `Replay boost: ${summary.join("; ")}`;
    }
  }

  function startReplayWatch() {
    activeReplayWatch = true;
    nativeWatchedReplayStatuses = null;
    watchedReplayCarsByWorker.clear();
    updateCheatReplayIndicator();
  }

  function stopReplayWatch() {
    activeReplayWatch = false;
    nativeWatchedReplayStatuses = null;
    watchedReplayCarsByWorker.clear();
    updateCheatReplayIndicator();
  }

  // The native preview lifecycle is authoritative. A Watch click alone misses
  // post-race Watch, and worker replacement does not mean the viewer has exited.
  window.__polytrackStartReplayWatch = (recordings) => {
    startReplayWatch();
    nativeWatchedReplayStatuses = recordings.map((recording) => {
      const serialized = typeof recording === "string"
        ? recording : recording?.serialize?.();
      const settings = normalizeReplayBoostSettings(recording?.replayBoostSettings) ||
        replayBoostSettingsByRecording.get(serialized);
      const timeline = normalizeReplayBoostTimeline(recording?.replayBoostTimeline) ||
        replayBoostTimelineByRecording.get(serialized);
      if (settings || timeline) return "boosted";
      return recording?.normalPhysicsConfirmed === true ||
        normalPhysicsConfirmedByRecording.has(serialized)
        ? "not-boosted" : "unknown";
    });
    updateCheatReplayIndicator();
  };
  window.__polytrackEndReplayWatch = stopReplayWatch;

  document.addEventListener("click", (event) => {
    const target = event.target;

    const trackSelectionButton = target?.closest?.(
      ".track-selection-ui .track > .button",
    );
    const trackInfoButton = target?.closest?.(".track-info-ui .button");
    const trackInfoIcon = trackInfoButton
      ?.querySelector?.("img.button-icon")
      ?.getAttribute("src");
    const trackInfoLabel = trackInfoButton?.textContent?.trim?.();
    const watchButton =
      target?.closest?.(".track-info-ui .button.watch") ||
      (trackInfoButton &&
        (trackInfoIcon === "images/preview.svg" || trackInfoLabel === "Watch"));
    const playButton =
      target?.closest?.(".track-info-ui .button.play") ||
      (trackInfoButton &&
        (trackInfoIcon === "images/play.svg" || trackInfoLabel === "Play"));
    const toolbarButton = target?.closest?.(".game-toolbar-ui .button");
    const toolbarIcon = toolbarButton
      ?.querySelector?.("img.button-icon")
      ?.getAttribute("src");
    const changesTrackFromToolbar =
      toolbarIcon === "images/play.svg" || toolbarIcon === "images/load.svg";
    if (trackSelectionButton || changesTrackFromToolbar) stopReplayWatch();
    else if (watchButton) startReplayWatch();
    else if (playButton) stopReplayWatch();

    const exitsReplayView =
      toolbarIcon === "images/quit.svg";
    if (exitsReplayView) stopReplayWatch();
    const previewButton = target?.closest?.(".preview-toolbar-ui .button");
    if (previewButton?.querySelector?.("img.button-icon")?.getAttribute("src") ===
        "images/back.svg") stopReplayWatch();
  }, true);

  publishCheatSettings();

  const userKeyPattern = /^(polytrack_v5_(?:prod|dev|beta)_user_)([0-2])$/i;
  const recordKeyPattern =
    /^(polytrack_v5_(?:prod|dev|beta)_record\d*_)([0-2])_(default|undeterministic)_([a-f0-9]{64})$/i;
  const migrationPrefix = "polytrack_leaderboard_migrated_v2_";
  const deletedPbPrefix = "polytrack_leaderboard_deleted_pb_v1_";
  const pendingNicknameUpdateKey = "polytrack_leaderboard_nickname_pending_v1";
  let selectedLeaderboardTrackId = null;
  let ownPbDeleteButton = null;
  const replayBoostSettingsByRecording = new Map();
  const replayBoostTimelineByRecording = new Map();
  const normalPhysicsConfirmedByRecording = new Set();
  let activeReplayWatch = false;
  let nativeWatchedReplayStatuses = null;
  const watchedReplayCarsByWorker = new Map();
  window.__polytrackReplayBoostSettingsByRecording = replayBoostSettingsByRecording;
  window.__polytrackPendingReplayBoostSettings = null;
  window.__polytrackPendingReplayBoostTimeline = null;
  window.__polytrackPendingNormalPhysicsConfirmed = null;

  function readJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  const profileBackupFormat = "polytrack-profile-backup";
  const profileBackupVersion = 1;
  const profileBackupMaximumSize = 25_000_000;
  const legacyProfileBackupKeyPattern =
    /^v[12]_(?:car|record_|track_|key_bindings$|settings$|user(?:_[0-2])?$)/i;
  let profileBackupDialog = null;

  function isProfileBackupStorageKey(key) {
    return typeof key === "string" &&
      ( /^polytrack_[a-z0-9_:-]+$/i.test(key) ||
        key === "car_colors" ||
        legacyProfileBackupKeyPattern.test(key) );
  }

  function buildProfileBackupPayload(storage = window.localStorage) {
    const entries = Object.keys(storage)
      .filter(isProfileBackupStorageKey)
      .sort()
      .map((key) => [key, storage.getItem(key)])
      .filter(([, value]) => typeof value === "string");
    return {
      format: profileBackupFormat,
      version: profileBackupVersion,
      exportedAt: new Date().toISOString(),
      entries,
    };
  }
  window.__polytrackBuildProfileBackupPayload = buildProfileBackupPayload;

  function validateProfileBackupPayload(payload) {
    if (!payload || payload.format !== profileBackupFormat ||
        payload.version !== profileBackupVersion ||
        !Array.isArray(payload.entries) || payload.entries.length < 1 ||
        payload.entries.length > 20_000) {
      throw new Error("This file is not a supported PolyTrack profile backup.");
    }
    const keys = new Set();
    let totalSize = 0;
    const entries = [];
    for (const entry of payload.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error("The profile backup contains an invalid saved item.");
      }
      const [key, value] = entry;
      if (!isProfileBackupStorageKey(key) || key.length > 256 ||
          typeof value !== "string" || value.length > profileBackupMaximumSize ||
          keys.has(key)) {
        throw new Error("The profile backup contains an invalid or duplicate saved item.");
      }
      keys.add(key);
      totalSize += key.length + value.length;
      if (totalSize > profileBackupMaximumSize) {
        throw new Error("This profile backup is too large to import.");
      }
      entries.push([key, value]);
    }
    return entries;
  }

  function getProfileBackupSummary(entries) {
    const profiles = entries.filter(([key]) => userKeyPattern.test(key)).length;
    const records = entries.filter(([key]) => recordKeyPattern.test(key)).length;
    return `${entries.length} saved items, including ${profiles} player profile${profiles === 1 ? "" : "s"} and ${records} personal best${records === 1 ? "" : "s"} with replay data.`;
  }

  function restoreProfileBackupPayload(payload) {
    const entries = validateProfileBackupPayload(payload);
    const storage = window.localStorage;
    const existingKeys = Object.keys(storage).filter(isProfileBackupStorageKey);
    if (existingKeys.length > 0 && !window.confirm(
      `Replace ${existingKeys.length} saved PolyTrack item${existingKeys.length === 1 ? "" : "s"} on this browser? This replaces local profiles, paint, settings, tracks, personal bests, and replays. It does not delete online leaderboard records. Export this browser's data first if you want to keep it.`,
    )) {
      return { cancelled: true, imported: 0, replaced: 0 };
    }

    const previousEntries = existingKeys
      .map((key) => [key, storage.getItem(key)])
      .filter(([, value]) => typeof value === "string");
    const touchedKeys = new Set([
      ...existingKeys,
      ...entries.map(([key]) => key),
    ]);
    try {
      for (const key of existingKeys) storage.removeItem(key);
      for (const [key, value] of entries) storage.setItem(key, value);
    } catch {
      try {
        for (const key of touchedKeys) storage.removeItem(key);
        for (const [key, value] of previousEntries) storage.setItem(key, value);
      } catch {
        throw new Error("Import failed and the previous browser data could not be restored.");
      }
      throw new Error("Import failed. The previous browser data was restored.");
    }
    return { cancelled: false, imported: entries.length, replaced: existingKeys.length };
  }

  function setProfileBackupStatus(status, message, state = "") {
    status.textContent = message;
    status.classList.remove("success", "error");
    if (state) status.classList.add(state);
  }

  function openProfileBackupDialog() {
    if (profileBackupDialog) {
      profileBackupDialog.backdrop.hidden = false;
      profileBackupDialog.closeButton.focus();
      return profileBackupDialog;
    }

    const backdrop = document.createElement("div");
    backdrop.id = "polytrack-profile-backup-backdrop";
    backdrop.hidden = false;
    backdrop.setAttribute("role", "presentation");
    const dialog = document.createElement("section");
    dialog.id = "polytrack-profile-backup-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "polytrack-profile-backup-title");

    const header = document.createElement("div");
    header.className = "polytrack-profile-backup-header";
    const title = document.createElement("h2");
    title.id = "polytrack-profile-backup-title";
    title.textContent = "Move your PolyTrack profile";
    const closeButton = document.createElement("button");
    closeButton.id = "polytrack-profile-backup-close";
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close profile backup");
    closeButton.addEventListener("click", () => { backdrop.hidden = true; });
    header.appendChild(title);
    header.appendChild(closeButton);

    const description = document.createElement("p");
    description.textContent =
      "Export or restore your player names, car paint, settings, custom tracks, personal bests, and replays.";
    const warning = document.createElement("p");
    warning.className = "polytrack-profile-warning";
    warning.textContent =
      "Your backup includes leaderboard profile tokens. Keep the file private; anyone with it can use those profiles.";
    const actions = document.createElement("div");
    actions.className = "polytrack-profile-backup-actions";
    const exportButton = document.createElement("button");
    exportButton.id = "polytrack-profile-export";
    exportButton.type = "button";
    exportButton.textContent = "Download profile backup";
    const importButton = document.createElement("button");
    importButton.id = "polytrack-profile-import";
    importButton.type = "button";
    importButton.textContent = "Import profile backup";
    const fileInput = document.createElement("input");
    fileInput.id = "polytrack-profile-backup-file";
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.hidden = true;
    const status = document.createElement("p");
    status.id = "polytrack-profile-backup-status";
    status.setAttribute("aria-live", "polite");

    exportButton.addEventListener("click", () => {
      try {
        const payload = buildProfileBackupPayload();
        if (payload.entries.length === 0) {
          setProfileBackupStatus(status, "No saved PolyTrack data was found to export.", "error");
          return;
        }
        const file = new window.Blob(
          [JSON.stringify(payload, null, 2)],
          { type: "application/json" },
        );
        const downloadUrl = window.URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = `polytrack-profile-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 1000);
        setProfileBackupStatus(status, `Downloaded ${getProfileBackupSummary(payload.entries)}`, "success");
      } catch {
        setProfileBackupStatus(status, "Could not create the profile backup file.", "error");
      }
    });

    importButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (event) => {
      const file = event.target?.files?.[0];
      if (!file) return;
      importButton.disabled = true;
      exportButton.disabled = true;
      try {
        if (Number.isFinite(file.size) && file.size > profileBackupMaximumSize) {
          throw new Error("This profile backup is too large to import.");
        }
        const raw = await file.text();
        if (raw.length > profileBackupMaximumSize) {
          throw new Error("This profile backup is too large to import.");
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new Error("The selected file is not valid JSON.");
        }
        const entries = validateProfileBackupPayload(payload);
        const result = restoreProfileBackupPayload({ ...payload, entries });
        if (result.cancelled) {
          setProfileBackupStatus(status, "Import cancelled. This browser's data was not changed.");
          return;
        }
        setProfileBackupStatus(
          status,
          `Restored ${getProfileBackupSummary(entries)} Reloading PolyTrack…`,
          "success",
        );
        setTimeout(() => window.location.reload(), 500);
      } catch (error) {
        setProfileBackupStatus(
          status,
          error instanceof Error ? error.message : "Could not import this profile backup.",
          "error",
        );
      } finally {
        importButton.disabled = false;
        exportButton.disabled = false;
        fileInput.value = "";
      }
    });

    dialog.appendChild(header);
    dialog.appendChild(description);
    dialog.appendChild(warning);
    actions.appendChild(exportButton);
    actions.appendChild(importButton);
    dialog.appendChild(actions);
    dialog.appendChild(fileInput);
    dialog.appendChild(status);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) backdrop.hidden = true;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !backdrop.hidden) backdrop.hidden = true;
    });
    document.body.appendChild(backdrop);
    profileBackupDialog = { backdrop, closeButton };
    closeButton.focus();
    return profileBackupDialog;
  }

  window.__polytrackOpenProfileBackup = openProfileBackupDialog;

  function installProfileBackupButton() {
    const mainButtons = document.querySelector(".menu-ui .main-buttons-container");
    if (!mainButtons || document.getElementById("polytrack-profile-backup-button")) {
      return false;
    }
    const button = document.createElement("button");
    button.id = "polytrack-profile-backup-button";
    button.className = "button button-image";
    button.type = "button";
    button.title = "Export or import your PolyTrack profile";
    const icon = document.createElement("img");
    icon.src = "images/export.svg";
    icon.alt = "";
    const label = document.createElement("p");
    label.textContent = "Profile Backup";
    button.appendChild(icon);
    button.appendChild(label);
    button.addEventListener("click", openProfileBackupDialog);
    mainButtons.appendChild(button);
    return true;
  }
  window.__polytrackInstallProfileBackupButton = installProfileBackupButton;

  function findActiveProfile() {
    if (typeof window.__polytrackGetActiveProfile === "function") {
      const active = window.__polytrackGetActiveProfile();
      return active && userKeyPattern.test(active.key) &&
        typeof active.profile?.token === "string" && active.profile.token &&
        typeof active.profile.nickname === "string" ? active : null;
    }
    const namespaces = new Set();
    for (const key of Object.keys(window.localStorage)) {
      const match = userKeyPattern.exec(key);
      if (match) namespaces.add(match[1]);
    }
    for (const namespace of namespaces) {
      const storedSlot = window.localStorage.getItem(`${namespace}slot`);
      const slot = storedSlot === null ? 0 : Number.parseInt(storedSlot, 10);
      if (!Number.isSafeInteger(slot) || slot < 0 || slot > 2) continue;
      const key = `${namespace}${slot}`;
      const profile = readJson(window.localStorage.getItem(key) || "");
      if (profile && typeof profile.token === "string" && profile.token &&
          typeof profile.nickname === "string") {
        return { key, profile };
      }
    }
    return null;
  }

  function updateOwnPbDeleteControlState() {
    if (!ownPbDeleteButton) return;
    const hasProfile = Boolean(findActiveProfile());
    const hasTrack = Boolean(selectedLeaderboardTrackId);
    ownPbDeleteButton.disabled = !hasProfile || !hasTrack;
    ownPbDeleteButton.title = !hasProfile
      ? "Select a player profile to delete your PB"
      : hasTrack
        ? "Delete your PB for this map from this device and the leaderboard"
        : "Waiting for this map's leaderboard to load";
  }

  function tagLeaderboardRows(trackId, skip, amount, entries, total) {
    setTimeout(() => {
      if (selectedLeaderboardTrackId !== trackId ||
          typeof document.querySelector !== "function") return;
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      if (!leaderboard) return;
      const pages = leaderboard.querySelector(".pages");
      if (total === 0 && entries.length === 0) {
        for (const row of leaderboard.querySelector(".container")
          ?.querySelectorAll("button.main") || []) {
          row.remove();
        }
        if (pages) {
          pages.innerHTML = "";
          pages.hidden = true;
        }
        return;
      }
      if (pages) pages.hidden = false;
      const selectedPage = leaderboard.querySelector(".pages > button.selected");
      if (selectedPage &&
          Number(selectedPage.textContent.trim()) !== Math.floor(skip / amount) + 1) {
        return;
      }
      const rows = Array.from(
        leaderboard.querySelector(".container")?.querySelectorAll("button.main") || [],
      );
      if (rows.length !== entries.length) return;
      entries.forEach((entry, index) => {
        if (typeof entry?.userId === "string" && /^[a-f0-9]{64}$/i.test(entry.userId)) {
          rows[index].setAttribute("data-polytrack-user-id", entry.userId.toLowerCase());
        }
      });
    }, 0);
  }
  function updateLeaderboardAfterPbDeletion(
    trackId,
    userId,
    deletedRecords,
    deletedProfile,
  ) {
    if (!userId || selectedLeaderboardTrackId !== trackId ||
        typeof document.querySelector !== "function") return;
    const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
    if (!leaderboard) return;
    const container = leaderboard.querySelector(".container");
    const ownRows = Array.from(
      container?.querySelectorAll("button.main[data-polytrack-user-id]") || [],
    ).filter((row) => row.getAttribute("data-polytrack-user-id") === userId);
    for (const row of ownRows) row.remove();

    const totalPlayers = leaderboard.querySelector(".total-players");
    const currentTotal = Number.parseInt(totalPlayers?.textContent || "", 10);
    const removedCount = Math.max(
      ownRows.length,
      Number.isSafeInteger(deletedRecords) ? deletedRecords : 0,
    );
    if (totalPlayers && Number.isSafeInteger(currentTotal) && removedCount > 0) {
      totalPlayers.textContent = `${Math.max(0, currentTotal - removedCount)} players`;
    }

    const activeProfile = findActiveProfile();
    if (!deletedProfile || activeProfile?.key !== deletedProfile.key ||
        activeProfile.profile.token !== deletedProfile.profile.token) return;

    const personalBest = document.querySelector(
      ".track-info-ui .side-panel .personal-best",
    );
    for (const value of personalBest?.querySelectorAll("span") || []) {
      value.textContent = "---";
      value.classList.add("faded");
    }
    // Use the game's refresh path as well as updating the visible DOM. Its
    // callback now reads the current local record instead of an open-time copy.
    leaderboard.__polytrackRefreshLeaderboard?.();
  }

  function showFirstJoinNamePrompt(profileKey, profile) {
    if (document.getElementById("polytrack-name-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "polytrack-name-backdrop";
    backdrop.setAttribute("role", "presentation");
    const dialog = document.createElement("section");
    dialog.id = "polytrack-name-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "polytrack-name-title");

    const title = document.createElement("h2");
    title.id = "polytrack-name-title";
    title.textContent = "Choose your leaderboard name";
    const description = document.createElement("p");
    description.textContent =
      "Pick a name to show beside your times on the leaderboard.";

    const form = document.createElement("form");
    form.id = "polytrack-name-form";
    const input = document.createElement("input");
    input.id = "polytrack-name-input";
    input.type = "text";
    input.name = "nickname";
    input.maxLength = 32;
    input.autocomplete = "nickname";
    input.placeholder = "Your name";
    input.setAttribute("aria-label", "Leaderboard name");
    input.setAttribute("required", "");

    const status = document.createElement("p");
    status.id = "polytrack-name-status";
    status.setAttribute("aria-live", "polite");
    const actions = document.createElement("div");
    actions.id = "polytrack-name-actions";
    const laterButton = document.createElement("button");
    laterButton.type = "button";
    laterButton.textContent = "Not now";
    laterButton.addEventListener("click", () => {
      backdrop.hidden = true;
    });
    const saveButton = document.createElement("button");
    saveButton.id = "polytrack-name-save";
    saveButton.type = "submit";
    saveButton.textContent = "Save name";

    actions.appendChild(laterButton);
    actions.appendChild(saveButton);
    form.appendChild(input);
    form.appendChild(status);
    form.appendChild(actions);
    dialog.appendChild(title);
    dialog.appendChild(description);
    dialog.appendChild(form);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    input.focus();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const nickname = input.value.trim();
      if (!nickname) {
        status.textContent = "Enter a name to continue.";
        input.focus();
        return;
      }
      if (nickname.length > 32) {
        status.textContent = "Names must be 32 characters or fewer.";
        input.focus();
        return;
      }
      if (nickname.toLowerCase() === "anonymous") {
        status.textContent = "Choose a name other than Anonymous.";
        input.focus();
        return;
      }

      saveButton.disabled = true;
      laterButton.disabled = true;
      status.style.color = "#aab7ca";
      status.textContent = "Saving your leaderboard name…";
      try {
        const current = readJson(window.localStorage.getItem(profileKey) || "");
        if (!current || current.token !== profile.token) {
          throw new Error("The active profile changed before the name was saved");
        }
        current.nickname = nickname;
        window.localStorage.setItem(profileKey, JSON.stringify(current));
        await window.__polytrackProfileNicknameSaved?.(
          current.token,
          nickname,
        );
        status.style.color = "#a9e5b1";
        status.textContent = "Name saved. Reloading to apply it…";
        setTimeout(() => window.location.reload(), 700);
      } catch {
        status.style.color = "#ffb5b5";
        status.textContent = "Could not save your name. Try again.";
        saveButton.disabled = false;
        laterButton.disabled = false;
      }
    });
  }

  async function postLeaderboardNickname(token, nickname) {
    const response = await fetch("/api/v6/leaderboardNickname", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ userToken: token, nickname }),
    });
    if (!response.ok) throw new Error("Nickname update failed");
    const result = await response.json();
    if (!Number.isSafeInteger(result?.updatedRecords) || result.updatedRecords < 0) {
      throw new Error("Nickname update returned an invalid result");
    }
    return result;
  }

  function flushPendingLeaderboardNicknameUpdate() {
    if (nicknameUpdatePromise) return nicknameUpdatePromise;
    nicknameUpdatePromise = (async () => {
      try {
        while (true) {
          const pending = readJson(
            window.localStorage.getItem(pendingNicknameUpdateKey) || "",
          );
          if (!pending || typeof pending.token !== "string" || !pending.token ||
              typeof pending.nickname !== "string" || !pending.nickname) {
            return false;
          }

          const result = await postLeaderboardNickname(
            pending.token,
            pending.nickname,
          );
          const latest = readJson(
            window.localStorage.getItem(pendingNicknameUpdateKey) || "",
          );
          if (latest?.token !== pending.token ||
              latest?.nickname !== pending.nickname) continue;

          window.localStorage.removeItem(pendingNicknameUpdateKey);
          if (result.updatedRecords > 0) {
            toast(
              `Updated ${result.updatedRecords} saved leaderboard time${result.updatedRecords === 1 ? "" : "s"}`,
            );
          }
          return true;
        }
      } catch (error) {
        console.warn("Leaderboard nickname update failed:", error);
        toast(
          "Garage name saved, but leaderboard times could not be updated yet. We’ll retry automatically.",
        );
        return false;
      }
    })().finally(() => {
      nicknameUpdatePromise = null;
    });
    return nicknameUpdatePromise;
  }

  window.__polytrackProfileNicknameSaved = (token, nickname) => {
    const normalizedNickname =
      typeof nickname === "string" ? nickname.trim() : "";
    if (typeof token !== "string" || !token || !normalizedNickname ||
        normalizedNickname.length > 32 ||
        normalizedNickname.toLowerCase() === "anonymous") {
      return Promise.resolve(false);
    }
    try {
      window.localStorage.setItem(
        pendingNicknameUpdateKey,
        JSON.stringify({ token, nickname: normalizedNickname }),
      );
    } catch (error) {
      console.warn("Could not queue leaderboard nickname update:", error);
      toast("Could not save the leaderboard update for retry.");
      return Promise.resolve(false);
    }
    return flushPendingLeaderboardNicknameUpdate();
  };

  function rememberLocalReplayForRepair(recording) {
    let matchingRecord = null;
    if (typeof recording === "string") {
      for (const key of Object.keys(window.localStorage)) {
        if (!recordKeyPattern.test(key)) continue;
        const record = readJson(window.localStorage.getItem(key) || "");
        if (record?.recording !== recording) continue;
        matchingRecord = { key, recording };
        break;
      }
    }
    lastReplayToRepair = matchingRecord;
    if (replayRepairButton) replayRepairButton.disabled = !matchingRecord;
  }

  // Startup cleanup can run before the official/custom track lists have
  // finished loading. Preserve PBs during that pass, while leaving explicit
  // deletes (including deleting a profile or custom track) unchanged.
  const NativeStorage = window.Storage;
  if (NativeStorage?.prototype?.removeItem) {
    const nativeRemoveItem = NativeStorage.prototype.removeItem;
    NativeStorage.prototype.removeItem = function (key) {
      if (
        typeof key === "string" &&
        recordKeyPattern.test(key) &&
        new Error().stack?.includes("cleanUpRecords")
      ) {
        return;
      }
      return nativeRemoveItem.call(this, key);
    };
  }
  if (NativeStorage?.prototype?.getItem && NativeStorage?.prototype?.setItem) {
    const nativeGetItem = NativeStorage.prototype.getItem;
    const nativeSetItem = NativeStorage.prototype.setItem;
    NativeStorage.prototype.getItem = function (key) {
      const value = nativeGetItem.call(this, key);
      if (typeof key === "string" && recordKeyPattern.test(key) && value) {
        const record = readJson(String(value));
          const settings = normalizeReplayBoostSettings(record?.replayBoostSettings);
          const timeline = normalizeReplayBoostTimeline(record?.replayBoostTimeline);
        if (typeof record?.recording === "string") {
          if (record.normalPhysicsConfirmed === true) {
            normalPhysicsConfirmedByRecording.add(record.recording);
          } else {
            normalPhysicsConfirmedByRecording.delete(record.recording);
          }
        }
        if (settings && typeof record?.recording === "string") {
          replayBoostSettingsByRecording.set(record.recording, settings);
        }
        if (timeline && typeof record?.recording === "string") {
          replayBoostTimelineByRecording.set(record.recording, timeline);
        }
      }
      return value;
    };
    NativeStorage.prototype.setItem = function (key, value) {
      if (typeof key === "string" && recordKeyPattern.test(key)) {
        const record = readJson(String(value));
        const previous = readJson(nativeGetItem.call(this, key) || "");
        const sameRecording = previous?.recording === record?.recording;
        const sameReplay = sameRecording &&
          Number.isSafeInteger(record?.frames) &&
          previous?.frames === record.frames;
        const hadNormalPhysicsConfirmation =
          record?.normalPhysicsConfirmed === true;
        const isExplicitRepair = repairingRecordKey === key;
        const activeLocalRun = !isExplicitRepair && !sameReplay
          ? Array.from(simulationWorkers).find((worker) =>
            worker.localCarId !== null &&
            (worker.localRunNormalPhysicsConfirmed !== null ||
              worker.localReplayBoostSegments.length > 0))
          : undefined;
        const activeTimeline = activeLocalRun
          ? normalizeReplayBoostTimeline({
            version: 1,
            segments: activeLocalRun.localReplayBoostSegments,
          })
          : null;
        const activeSettings = activeTimeline?.segments.find((segment) =>
          Object.values(normalizeBoostValues(segment) || {}).some((multiplier) => multiplier !== 1)
        );
        const hasPendingRunResult = !isExplicitRepair && !sameReplay &&
          (typeof window.__polytrackPendingNormalPhysicsConfirmed === "boolean" ||
            window.__polytrackPendingReplayBoostSettings !== null ||
            window.__polytrackPendingReplayBoostTimeline !== null ||
            activeLocalRun !== undefined);
        const timeline = normalizeReplayBoostTimeline(record?.replayBoostTimeline) ||
          (sameReplay
            ? normalizeReplayBoostTimeline(previous?.replayBoostTimeline)
            : null) ||
          (hasPendingRunResult
            ? normalizeReplayBoostTimeline(window.__polytrackPendingReplayBoostTimeline) ||
              activeTimeline
            : null);
        const settings = normalizeReplayBoostSettings(record?.replayBoostSettings) ||
          (sameReplay
            ? normalizeReplayBoostSettings(previous?.replayBoostSettings)
            : null) ||
          (hasPendingRunResult
            ? normalizeReplayBoostSettings(window.__polytrackPendingReplayBoostSettings) ||
              normalizeReplayBoostSettings(activeSettings)
            : null);
        const normalPhysicsConfirmed = !settings && !timeline &&
          (hasPendingRunResult
            ? window.__polytrackPendingNormalPhysicsConfirmed === true ||
              activeLocalRun?.localRunNormalPhysicsConfirmed === true
            : sameReplay &&
              (record?.normalPhysicsConfirmed === true ||
                previous?.normalPhysicsConfirmed === true) ||
              (!previous && record?.normalPhysicsConfirmed === true));
        if (hasPendingRunResult) {
          window.__polytrackPendingNormalPhysicsConfirmed = null;
          window.__polytrackPendingReplayBoostSettings = null;
          window.__polytrackPendingReplayBoostTimeline = null;
          if (activeLocalRun) activeLocalRun.localRunMetadataPersisted = true;
        }
        if (record && typeof record.recording === "string") {
          if (normalPhysicsConfirmed) {
            record.normalPhysicsConfirmed = true;
            normalPhysicsConfirmedByRecording.add(record.recording);
          } else {
            delete record.normalPhysicsConfirmed;
            normalPhysicsConfirmedByRecording.delete(record.recording);
          }
        }
        if (record && typeof record.recording === "string" &&
            (settings || timeline || normalPhysicsConfirmed ||
              hadNormalPhysicsConfirmation)) {
          if (settings) {
            record.replayBoostSettings = settings;
            replayBoostSettingsByRecording.set(record.recording, settings);
          }
          if (timeline) {
            record.replayBoostTimeline = timeline;
            replayBoostTimelineByRecording.set(record.recording, timeline);
          }
          value = JSON.stringify(record);
        }
        if (record && typeof record.recording === "string") {
          if (settings) replayBoostSettingsByRecording.set(record.recording, settings);
          else replayBoostSettingsByRecording.delete(record.recording);
          if (timeline) replayBoostTimelineByRecording.set(record.recording, timeline);
          else replayBoostTimelineByRecording.delete(record.recording);
        }
      }
      return nativeSetItem.call(this, key, value);
    };
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  async function uploadSavedRecord(profile, trackId, record, onlyVerified) {
    const form = new URLSearchParams();
    form.set("version", "v6");
    form.set("userToken", profile.token);
    form.set("nickname", profile.nickname);
    if (typeof profile.countryCode === "string" && profile.countryCode.length > 0) {
      form.set("countryCode", profile.countryCode);
    }
    form.set("carStyle", profile.carStyle);
    form.set("trackId", trackId);
    form.set("frames", String(record.frames));
    form.set("recording", record.recording);
    form.set("onlyVerified", String(onlyVerified));
    const replayBoostSettings = normalizeReplayBoostSettings(record.replayBoostSettings);
    if (replayBoostSettings) {
      form.set("replayBoostSettings", JSON.stringify(replayBoostSettings));
    }
    const replayBoostTimeline = normalizeReplayBoostTimeline(record.replayBoostTimeline);
    if (replayBoostTimeline) {
      form.set("replayBoostTimeline", JSON.stringify(replayBoostTimeline));
    }
    if (record.normalPhysicsConfirmed === true) {
      form.set("normalPhysicsConfirmed", "true");
    }

    const response = await fetch("/api/v6/leaderboard", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Saved leaderboard upload failed with ${response.status}`);
    }
    const result = readJson(await response.text());
    if (!result || !Number.isSafeInteger(result.uploadId)) {
      throw new Error("Saved leaderboard upload returned an invalid id");
    }
    return result.uploadId;
  }

  async function findServerRecord(profile, trackId, onlyVerified) {
    const query = new URLSearchParams({
      version: "v6",
      trackId,
      userTokenHash: profile.tokenHash,
      onlyVerified: String(onlyVerified),
    });
    const response = await fetch(`/api/v6/leaderboardUserEntry?${query}`);
    if (!response.ok) throw new Error(`Leaderboard lookup failed with ${response.status}`);
    const entry = await response.json();
    if (entry === null) return null;
    if (!Number.isSafeInteger(entry.frames) ||
        !Number.isSafeInteger(entry.id)) {
      throw new Error("Leaderboard lookup returned an invalid record");
    }
    return entry;
  }

  async function savedRecordFingerprint(record) {
    const replayBoostSettings = normalizeReplayBoostSettings(record.replayBoostSettings);
    const replayBoostTimeline = normalizeReplayBoostTimeline(record.replayBoostTimeline);
    return `${record.tokenHash}:${record.frames}:${await sha256(record.recording)}` +
      (replayBoostSettings ? `:${JSON.stringify(replayBoostSettings)}` : "") +
      (replayBoostTimeline ? `:${JSON.stringify(replayBoostTimeline)}` : "") +
      (record.normalPhysicsConfirmed === true ? ":normalPhysicsConfirmed" : "");
  }

  async function deleteOwnPbForTrack(trackId) {
    if (typeof trackId !== "string" || !/^[a-f0-9]{64}$/i.test(trackId)) {
      throw new Error("The selected map could not be identified");
    }
    trackId = trackId.toLowerCase();
    const active = findActiveProfile();
    if (!active) throw new Error("Select a player profile before deleting a PB");
    const token = active.profile.token;
    const leaderboard = selectedLeaderboardTrackId === trackId
      ? document.querySelector(".track-info-ui .leaderboard-ui") : null;
    leaderboard?.__polytrackPreparePbDeletion?.();
    await window.__polytrackWaitForRecordWrites?.(trackId);
    const currentProfile = findActiveProfile();
    if (currentProfile?.key !== active.key || currentProfile.profile.token !== token) {
      leaderboard?.__polytrackRefreshLeaderboard?.();
      throw new Error("The active profile changed before deleting the PB");
    }
    const tokenHash = await sha256(token);
    const storage = window.localStorage;
    const matchingRecords = [];

    for (const key of Object.keys(storage)) {
      const match = recordKeyPattern.exec(key);
      if (!match || match[4].toLowerCase() !== trackId) continue;
      const record = readJson(storage.getItem(key) || "");
      if (record?.tokenHash !== tokenHash ||
          !Number.isSafeInteger(record.frames) ||
          typeof record.recording !== "string") continue;
      matchingRecords.push({
        key,
        fingerprint: await savedRecordFingerprint(record),
      });
    }

    let serverDeleted = false;
    try {
      for (const record of matchingRecords) {
        storage.setItem(`${deletedPbPrefix}${record.key}`, record.fingerprint);
      }
      if (migrationRunning) await migrationSettled;

      const latestProfile = findActiveProfile();
      if (latestProfile?.key !== active.key ||
          latestProfile.profile.token !== token) {
        throw new Error("The active player changed before deletion completed");
      }
      const response = await fetch("/api/v6/leaderboard", {
        method: "DELETE",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ userToken: token, trackId }),
      });
      if (!response.ok) {
        throw new Error(`Leaderboard deletion failed with ${response.status}`);
      }
      serverDeleted = true;
      let deletedRecords = 0;
      try {
        const result = await response.json();
        if (Number.isSafeInteger(result?.deletedRecords) && result.deletedRecords >= 0) {
          deletedRecords = result.deletedRecords;
        }
      } catch {
        // A successful DELETE status confirms the operation; its body is only
        // needed for an optional leaderboard-count hint.
      }

      let localCleanupFailed = false;
      for (const record of matchingRecords) {
        const current = readJson(storage.getItem(record.key) || "");
        if (!current || current.tokenHash !== tokenHash ||
            await savedRecordFingerprint(current) !== record.fingerprint) continue;
        try {
          storage.removeItem(record.key);
          storage.removeItem(`${migrationPrefix}${record.key}`);
          verifiedAt.delete(`${migrationPrefix}${record.key}`);
        } catch {
          localCleanupFailed = true;
        }
      }
      toast(localCleanupFailed
        ? "Leaderboard PB deleted. A local storage issue prevented removing the device copy, but it will not sync again."
        : "Personal best deleted from this device and the leaderboard.");
      return { deletedRecords };
    } catch (error) {
      leaderboard?.__polytrackRefreshLeaderboard?.();
      if (!serverDeleted) {
        for (const record of matchingRecords) {
          const markerKey = `${deletedPbPrefix}${record.key}`;
          if (storage.getItem(markerKey) === record.fingerprint) {
            storage.removeItem(markerKey);
          }
        }
      }
      throw error;
    }
  }

  function installOwnPbDeleteControl(button) {
    if (!button?.classList || button.classList.contains("polytrack-delete-pb")) {
      return false;
    }
    selectedLeaderboardTrackId = null;
    ownPbDeleteButton = button;
    button.classList.remove("only-verified", "disabled");
    button.classList.add("polytrack-delete-pb");
    button.textContent = "Delete PB";
    button.type = "button";
    updateOwnPbDeleteControlState();
    button.setAttribute("aria-label", "Delete your personal best for this map");

    let deleting = false;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (deleting || button.disabled) return;
      const trackId = selectedLeaderboardTrackId;
      if (!trackId) {
        toast("Could not identify the selected map. Reopen its leaderboard and try again.");
        return;
      }
      if (!window.confirm(
        "Delete your personal best for this map from this device and the leaderboard? This cannot be undone.",
      )) return;

      deleting = true;
      button.disabled = true;
      button.textContent = "Deleting…";
      const activeProfile = findActiveProfile();
      const userIdPromise = activeProfile
        ? sha256(activeProfile.profile.token)
        : Promise.resolve(null);
      button.__polytrackDeletePromise = deleteOwnPbForTrack(trackId).then(async (result) => {
        try {
          const userId = await userIdPromise;
          const currentProfile = findActiveProfile();
          const profileStillActive = Boolean(activeProfile && currentProfile &&
            currentProfile.key === activeProfile.key &&
            currentProfile.profile.token === activeProfile.profile.token);
          button.textContent = profileStillActive ? "PB deleted" : "Delete PB";
          if (!profileStillActive) updateOwnPbDeleteControlState();
          updateLeaderboardAfterPbDeletion(
            trackId,
            userId,
            result.deletedRecords,
            activeProfile,
          );
        } catch (error) {
          console.warn("Could not refresh the leaderboard view after deletion:", error);
        }
      }).catch((error) => {
        console.warn("Personal best deletion failed:", error);
        toast("Could not delete your personal best. Your local PB was kept; try again.");
        button.textContent = "Delete PB";
        updateOwnPbDeleteControlState();
      }).finally(() => {
        deleting = false;
      });
    }, true);
    return true;
  }
  window.__polytrackInstallOwnPbDeleteControl = installOwnPbDeleteControl;
  window.__polytrackDeleteOwnPbForTrack = deleteOwnPbForTrack;

  let migrationRunning = false;
  let migrationSettled = Promise.resolve();
  let resolveMigrationSettled = null;
  const verifiedAt = new Map();
  async function syncSavedRecords() {
    if (migrationRunning) return;
    migrationRunning = true;
    migrationSettled = new Promise((resolve) => {
      resolveMigrationSettled = resolve;
    });
    try {
      const storage = window.localStorage;
      const keys = Object.keys(storage);
      const profiles = new Map();
      for (const key of keys) {
        const match = userKeyPattern.exec(key);
        if (!match) continue;
        const profile = readJson(storage.getItem(key) || "");
        if (
          !profile ||
          typeof profile.token !== "string" ||
          !profile.token ||
          typeof profile.nickname !== "string" ||
          !profile.nickname ||
          typeof profile.carStyle !== "string" ||
          !profile.carStyle
        ) continue;
        profiles.set(`${match[1]}${match[2]}`, {
          ...profile,
          tokenHash: await sha256(profile.token),
        });
      }

      let uploaded = 0;
      for (const key of keys) {
        const match = recordKeyPattern.exec(key);
        if (!match) continue;
        const [, prefix, slot, category, rawTrackId] = match;
        const namespace = prefix.replace(/record\d*_$/i, "user_");
        const profile = profiles.get(`${namespace}${slot}`);
        if (!profile) continue;
        const record = readJson(storage.getItem(key) || "");
        if (
          !record ||
          record.tokenHash !== profile.tokenHash ||
          !Number.isSafeInteger(record.frames) ||
          record.frames < 1 ||
          record.frames > 2_000_000 ||
          typeof record.recording !== "string" ||
          !record.recording ||
          record.recording.length > 200_000
        ) continue;

        const replayBoostSettings = normalizeReplayBoostSettings(record.replayBoostSettings);
        const replayBoostTimeline = normalizeReplayBoostTimeline(record.replayBoostTimeline);
        const normalPhysicsConfirmed = record.normalPhysicsConfirmed === true;
        const fingerprint = await savedRecordFingerprint(record);
        if (storage.getItem(`${deletedPbPrefix}${key}`) === fingerprint) continue;
        const migrationKey = `${migrationPrefix}${key}`;
        const lastVerified = verifiedAt.get(migrationKey) ?? 0;
        if (storage.getItem(migrationKey) === fingerprint &&
            Date.now() - lastVerified < 300_000) continue;
        try {
          const trackId = rawTrackId.toLowerCase();
          const onlyVerified = category === "default";
          const needsMetadataLookup = Boolean(
            replayBoostSettings || replayBoostTimeline || normalPhysicsConfirmed,
          );
          const serverRecord = storage.getItem(migrationKey) === fingerprint ||
            needsMetadataLookup
            ? await findServerRecord(profile, trackId, onlyVerified)
            : null;
          if (storage.getItem(`${deletedPbPrefix}${key}`) === fingerprint) continue;
          const needsUpload = !serverRecord || serverRecord.frames > record.frames ||
            (serverRecord.frames === record.frames &&
              ((replayBoostSettings && !serverRecord.hasReplayBoostSettings) ||
               (replayBoostTimeline && !serverRecord.hasReplayBoostTimeline) ||
               (normalPhysicsConfirmed && !serverRecord.hasConfirmedNormalPhysics)));
          const uploadId = needsUpload
            ? await uploadSavedRecord(profile, trackId, record, onlyVerified)
            : serverRecord.id;
          const current = readJson(storage.getItem(key) || "");
          if (current?.frames !== record.frames ||
              current?.recording !== record.recording ||
              current?.tokenHash !== record.tokenHash ||
              JSON.stringify(current?.replayBoostTimeline) !==
                JSON.stringify(record.replayBoostTimeline) ||
              current?.normalPhysicsConfirmed !== record.normalPhysicsConfirmed) continue;
          // A non-deterministic run cannot use native leaderboard sync.
          // Keep its local PB intact and only mark its server-side upload.
          if (onlyVerified && (!serverRecord ||
              serverRecord.frames === record.frames ||
              needsUpload)) {
            current.uploadId = uploadId;
            storage.setItem(key, JSON.stringify(current));
          }
          storage.setItem(migrationKey, fingerprint);
          verifiedAt.set(migrationKey, Date.now());
          if (needsUpload) uploaded += 1;
        } catch (error) {
          console.warn("Failed to upload saved leaderboard record:", error);
        }
      }
      if (uploaded > 0) {
        toast(`Uploaded ${uploaded} saved personal best${uploaded === 1 ? "" : "s"}`);
      }
    } finally {
      migrationRunning = false;
      resolveMigrationSettled?.();
      resolveMigrationSettled = null;
    }
  }

  window.addEventListener("load", () => {
    const activeProfile = findActiveProfile();
    if (activeProfile?.profile.nickname.trim().toLowerCase() === "anonymous") {
      showFirstJoinNamePrompt(activeProfile.key, activeProfile.profile);
    }
    const sync = () => {
      flushPendingLeaderboardNicknameUpdate();
      syncSavedRecords().catch((error) =>
        console.warn("Saved leaderboard sync failed:", error),
      );
    };
    setTimeout(sync, 1500);
    setInterval(sync, 15000);
  });

  const NativeXmlHttpRequest = window.XMLHttpRequest;
  const nativeOpen = NativeXmlHttpRequest.prototype.open;
  NativeXmlHttpRequest.prototype.open = function (method, url, ...rest) {
    let rewrittenUrl =
      typeof url === "string"
        ? url.replace("https://vps.kodub.com:43274/", "/api/")
        : url;
    if (method?.toUpperCase() === "GET" &&
        typeof rewrittenUrl === "string" &&
        /\/api\/v6\/leaderboard(?:\?|$)/.test(rewrittenUrl)) {
      const queryIndex = rewrittenUrl.indexOf("?");
      if (queryIndex >= 0) {
        const params = new URLSearchParams(rewrittenUrl.slice(queryIndex + 1));
        params.delete("replayBoostStatus");
        rewrittenUrl = `${rewrittenUrl.slice(0, queryIndex)}?${params}`;
      }
    }
    if (method?.toUpperCase() === "GET" &&
        typeof rewrittenUrl === "string" &&
        /\/api\/v6\/leaderboard(?:\?|$)/.test(rewrittenUrl)) {
      const trackId = /[?&]trackId=([a-f0-9]{64})(?:&|$)/i.exec(rewrittenUrl)?.[1]
        ?.toLowerCase();
      const skip = Number(/[?&]skip=(\d+)(?:&|$)/i.exec(rewrittenUrl)?.[1] ?? 0);
      const amount = Number(/[?&]amount=(\d+)(?:&|$)/i.exec(rewrittenUrl)?.[1] ?? 20);
      if (trackId && Number.isSafeInteger(skip) && Number.isSafeInteger(amount) &&
          amount > 0) {
        this.addEventListener("readystatechange", () => {
          if (this.readyState !== NativeXmlHttpRequest.DONE || this.status !== 200) return;
          let response = null;
          try {
            response = readJson(this.responseText);
          } catch {
            return;
          }
          if (Array.isArray(response?.entries)) {
            tagLeaderboardRows(
              trackId,
              skip,
              amount,
              response.entries,
              response.total,
            );
          }
        });
      }
    }
    if (method?.toUpperCase() === "GET" &&
        typeof rewrittenUrl === "string" &&
        /\/api\/v6\/recordings(?:\?|$)/.test(rewrittenUrl)) {
      this.addEventListener("readystatechange", () => {
        if (this.readyState !== NativeXmlHttpRequest.DONE || this.status !== 200) return;
        const recordings = readJson(this.responseText);
        if (!Array.isArray(recordings)) return;
        for (const record of recordings) {
          const settings = normalizeReplayBoostSettings(record?.replayBoostSettings);
          const timeline = normalizeReplayBoostTimeline(record?.replayBoostTimeline);
          if (typeof record?.recording === "string") {
            if (record.normalPhysicsConfirmed === true) {
              normalPhysicsConfirmedByRecording.add(record.recording);
            } else {
              normalPhysicsConfirmedByRecording.delete(record.recording);
            }
            if (settings) replayBoostSettingsByRecording.set(record.recording, settings);
            else replayBoostSettingsByRecording.delete(record.recording);
            if (timeline) replayBoostTimelineByRecording.set(record.recording, timeline);
            else replayBoostTimelineByRecording.delete(record.recording);
          }
        }
      });
    }
    if (method?.toUpperCase() === "GET" &&
        typeof rewrittenUrl === "string" &&
        /\/api\/v6\/leaderboard(?:UserEntry)?(?:\?|$)/.test(rewrittenUrl)) {
      const trackMatch = /[?&]trackId=([a-f0-9]{64})(?:&|$)/i.exec(rewrittenUrl);
      selectedLeaderboardTrackId = trackMatch?.[1]?.toLowerCase() ?? null;
      updateOwnPbDeleteControlState();
    }
    return nativeOpen.call(this, method, rewrittenUrl, ...rest);
  };

  if (typeof window.MutationObserver === "function" && document.body) {
    const profileBackupObserver = new window.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          if (node?.nodeType !== 1) continue;
          if (node.matches?.(".main-buttons-container") ||
              node.querySelector?.(".main-buttons-container")) {
            installProfileBackupButton();
            return;
          }
        }
      }
    });
    profileBackupObserver.observe(document.body, { childList: true, subtree: true });
    installProfileBackupButton();

    const ownPbObserver = new window.MutationObserver((mutations) => {
      const visit = (node) => {
        if (!node || node.nodeType !== 1) return;
        if (node.matches?.(".button.only-verified")) {
          installOwnPbDeleteControl(node);
        }
        for (const child of node.querySelectorAll?.(".button.only-verified") || []) {
          installOwnPbDeleteControl(child);
        }
      };
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) visit(node);
      }
    });
    ownPbObserver.observe(document.body, { childList: true, subtree: true });
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === "function") {
    window.WebSocket = class extends NativeWebSocket {
    constructor(url, options) {
      const isSimulationWorker =
        typeof url === "string" && url.endsWith("simulation_worker.bundle.js");
      const workerUrl = isSimulationWorker ? "site-simulation-worker.js" : url;
      super(workerUrl, options);
      this.isSimulationWorker = isSimulationWorker;
      this.localCarId = null;
      this.lastLocalControls = null;
      this.localReplayBoostSegments = [];
      this.localRunNormalPhysicsConfirmed = null;
      this.localRunMetadataPersisted = false;
      if (isSimulationWorker) {
        simulationWorkers.add(this);
        super.addEventListener("message", (event) => {
          this.captureReplayBoostFrames(event.data);
        });
      }
    }
    };
  }

  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      const isSimulationWorker =
        typeof url === "string" && url.endsWith("simulation_worker.bundle.js");
      const workerUrl = isSimulationWorker ? "site-simulation-worker.js" : url;
      super(workerUrl, options);
      this.isSimulationWorker = isSimulationWorker;
      this.localCarId = null;
      this.lastLocalControls = null;
      this.localReplayBoostSegments = [];
      this.localRunNormalPhysicsConfirmed = null;
      this.localRunMetadataPersisted = false;
      if (isSimulationWorker) {
        simulationWorkers.add(this);
        super.addEventListener("message", (event) => {
          this.captureReplayBoostFrames(event.data);
        });
      }
    }

    appendReplayBoostFrame(frame, values) {
      if (!Number.isSafeInteger(frame) || frame < 1 || frame > 2_000_000) return;
      const settings = normalizeBoostValues(values);
      if (!settings) return;
      const segments = this.localReplayBoostSegments;
      const previous = segments.at(-1);
      if (previous && frame <= previous.endFrame) return;
      if (previous && frame === previous.endFrame + 1 &&
          previous.accelerationMultiplier === settings.accelerationMultiplier &&
          previous.brakingMultiplier === settings.brakingMultiplier &&
          previous.topSpeedMultiplier === settings.topSpeedMultiplier) {
        previous.endFrame = frame;
      } else {
        segments.push({ startFrame: frame, endFrame: frame, ...settings });
      }
      this.publishPendingReplayBoostMetadata();
    }

    publishPendingReplayBoostMetadata() {
      const timeline = normalizeReplayBoostTimeline({
        version: 1,
        segments: this.localReplayBoostSegments,
      });
      window.__polytrackPendingReplayBoostTimeline = timeline;
      const firstBoost = timeline?.segments.find((segment) =>
        Object.values(normalizeBoostValues(segment) || {}).some((multiplier) => multiplier !== 1)
      );
      window.__polytrackPendingReplayBoostSettings = firstBoost
        ? normalizeReplayBoostSettings(firstBoost)
        : null;
    }

    captureReplayBoostFrames(message) {
      if (!this.isSimulationWorker || this.localCarId === null ||
          !Array.isArray(message?.__polytrackBoostFrames)) return;
      for (const item of message.__polytrackBoostFrames) {
        if (item?.carId === this.localCarId) {
          this.appendReplayBoostFrame(item.frame, item.settings);
        }
      }
    }

    refreshCheatSettings() {
      if (this.isSimulationWorker && this.lastLocalControls) {
        this.postMessage(this.lastLocalControls);
      }
    }

    terminate() {
      simulationWorkers.delete(this);
      const hadWatchedReplayCars = watchedReplayCarsByWorker.has(this);
      watchedReplayCarsByWorker.delete(this);
      if (activeReplayWatch && nativeWatchedReplayStatuses === null && hadWatchedReplayCars &&
          watchedReplayCarsByWorker.size === 0) {
        activeReplayWatch = false;
      }
      updateCheatReplayIndicator();
      return super.terminate();
    }

    postMessage(message, transfer) {
      if (this.isSimulationWorker && message?.messageType === 4) {
        const watchedCars = watchedReplayCarsByWorker.get(this);
        if (watchedCars?.delete(message.carId)) {
          if (watchedCars.size === 0) watchedReplayCarsByWorker.delete(this);
          if (nativeWatchedReplayStatuses === null &&
              watchedReplayCarsByWorker.size === 0) activeReplayWatch = false;
          updateCheatReplayIndicator();
        }
      }
      if (this.isSimulationWorker && message?.messageType === 3 &&
          message.carRecording == null &&
          this.localCarId === null) {
        this.localCarId = message.carId;
        this.localReplayBoostSegments = [];
        this.localRunNormalPhysicsConfirmed = null;
        this.localRunMetadataPersisted = false;
        window.__polytrackPendingReplayBoostSettings = null;
        window.__polytrackPendingReplayBoostTimeline = null;
        window.__polytrackPendingNormalPhysicsConfirmed = null;
      } else if (this.isSimulationWorker && message?.messageType === 4 &&
                 message.carId === this.localCarId) {
        if (this.localRunMetadataPersisted) {
          window.__polytrackPendingReplayBoostSettings = null;
          window.__polytrackPendingReplayBoostTimeline = null;
          window.__polytrackPendingNormalPhysicsConfirmed = null;
        } else {
          this.publishPendingReplayBoostMetadata();
          window.__polytrackPendingNormalPhysicsConfirmed =
            this.localRunNormalPhysicsConfirmed === true;
        }
        this.localCarId = null;
        this.lastLocalControls = null;
        this.localRunNormalPhysicsConfirmed = null;
      }
      if (this.isSimulationWorker && message?.messageType === 3 &&
          message.carRecording != null) {
        rememberLocalReplayForRepair(message.carRecording);
        const replayBoostTimeline =
          normalizeReplayBoostTimeline(message.replayBoostTimeline) ||
          replayBoostTimelineByRecording.get(message.carRecording);
        const replayBoostSettings =
          normalizeReplayBoostSettings(message.replayBoostSettings) ||
          replayBoostSettingsByRecording.get(message.carRecording) ||
          replayBoostTimeline?.segments.find((segment) =>
            Object.values(normalizeBoostValues(segment) || {}).some((multiplier) => multiplier !== 1)
          );
        const normalPhysicsConfirmed =
          message.normalPhysicsConfirmed === true ||
          normalPhysicsConfirmedByRecording.has(message.carRecording);
        if (activeReplayWatch) {
          let watchedCars = watchedReplayCarsByWorker.get(this);
          if (!watchedCars) {
            watchedCars = new Map();
            watchedReplayCarsByWorker.set(this, watchedCars);
          }
          watchedCars.set(
            message.carId,
            replayBoostSettings || replayBoostTimeline
              ? "boosted"
              : normalPhysicsConfirmed ? "not-boosted" : "unknown",
          );
          updateCheatReplayIndicator();
        }
        if (replayBoostSettings || replayBoostTimeline || normalPhysicsConfirmed) {
          message = {
            ...message,
            ...(replayBoostSettings ? { replayBoostSettings } : {}),
            ...(replayBoostTimeline ? { replayBoostTimeline } : {}),
            ...(normalPhysicsConfirmed ? { normalPhysicsConfirmed: true } : {}),
          };
        }
      }
      if (this.isSimulationWorker && message?.messageType === 6) {
        const isLocalCar = message.carId === this.localCarId;
        if (isLocalCar) this.lastLocalControls = { ...message };
        const settings = window.__polytrackCheatSettings || {
          accelerationMultiplier: 1,
          topSpeedMultiplier: 1,
          brakingMultiplier: 1,
        };
        const replayBoostSettings =
          isLocalCar && window.__polytrackCheatUnlocked
            ? normalizeReplayBoostSettings(settings)
            : null;
        if (isLocalCar) {
          const normalSettings = !window.__polytrackCheatUnlocked ||
            (settings.accelerationMultiplier === 1 &&
              settings.brakingMultiplier === 1 &&
              settings.topSpeedMultiplier === 1);
          this.localRunNormalPhysicsConfirmed =
            this.localRunNormalPhysicsConfirmed !== false && normalSettings;
        }
        message = {
          ...message,
          accelerationBoost: Boolean(isLocalCar && window.__polytrackCheatUnlocked &&
            (settings.accelerationMultiplier !== 1 || settings.brakingMultiplier !== 1)),
          accelerationMultiplier: isLocalCar && window.__polytrackCheatUnlocked
            ? settings.accelerationMultiplier : 1,
          topSpeedMultiplier: isLocalCar && window.__polytrackCheatUnlocked
            ? settings.topSpeedMultiplier : 1,
          brakingMultiplier: isLocalCar && window.__polytrackCheatUnlocked
            ? settings.brakingMultiplier : 1,
        };
      }
      if (transfer === undefined) {
        return super.postMessage(message);
      }
      return super.postMessage(message, transfer);
    }
  };

})();
