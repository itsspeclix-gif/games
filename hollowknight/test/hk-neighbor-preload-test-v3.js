(function () {
  'use strict';

  const VERSION = 'auto-neighbor-preload-test-v1';

  const MAP_URL =
    'https://cdn.jsdelivr.net/gh/itsspeclix-gif/games@eda4bcec2c31a5cb6a8126a6ab975fac74ba1df4/' +
    'hollowknight/build/preload-analysis/preload-map.analysis.json';

  const CHUNK_BASE =
    'https://cdn.jsdelivr.net/gh/itsspeclix-gif/games@main/' +
    'hollowknight/build/data4m/hk.data.part';

  const PART_SIZE = 4 * 1024 * 1024;
  const PART_COUNT = 208;
  const PRELOAD_CONCURRENCY = 2;
  const RECENT_READ_WINDOW_MS = 1800;

  if (
    window.__hkAutoNeighborPreloadTest &&
    typeof window.__hkAutoNeighborPreloadTest.show === 'function'
  ) {
    window.__hkAutoNeighborPreloadTest.show();
    return;
  }

  const state = {
    map: null,
    gameWindow: null,
    instance: null,
    module: null,
    FS: null,
    stats: null,

    currentScene: '',
    currentSource: '',
    detectedAt: 0,

    resourceToScene: new Map(),
    recentDataReads: [],
    candidateScene: '',
    candidateHits: 0,
    candidateTimer: null,

    warmController: null,
    warmGeneration: 0,
    warmedParts: new Set(),
    activeWarmParts: new Set(),

    lastFileRestore: null,
    dataReadRestore: null,

    badge: null,
    badgeMain: null,
    badgeSub: null,
    hidden: false
  };

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function setBadge(main, sub) {
    if (state.badgeMain) state.badgeMain.textContent = main;
    if (state.badgeSub) state.badgeSub.textContent = sub || '';
  }

  function createBadge() {
    if (state.badge) return;

    const badge = document.createElement('div');

    badge.id = '__hk_auto_neighbor_preload_badge';
    badge.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'right:10px',
      'top:10px',
      'max-width:min(360px,calc(100vw - 20px))',
      'padding:9px 11px',
      'border-radius:10px',
      'border:1px solid rgba(255,255,255,.18)',
      'background:rgba(12,12,20,.88)',
      'color:#fff',
      'font:12px/1.35 system-ui,-apple-system,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.38)',
      'pointer-events:auto',
      'user-select:none'
    ].join(';');

    badge.innerHTML = `
      <div id="__hk_auto_main" style="font-weight:800">
        HK auto preload: starting…
      </div>
      <div id="__hk_auto_sub"
           style="opacity:.7;font-size:10px;margin-top:2px">
        ${VERSION}
      </div>
    `;

    badge.title =
      'Automatic Hollow Knight neighbor preloading test. Click to hide.';

    badge.addEventListener('click', () => {
      badge.style.display = 'none';
      state.hidden = true;
    });

    document.documentElement.appendChild(badge);

    state.badge = badge;
    state.badgeMain = badge.querySelector('#__hk_auto_main');
    state.badgeSub = badge.querySelector('#__hk_auto_sub');
  }

  function showBadge() {
    createBadge();

    if (state.badge) {
      state.badge.style.display = 'block';
      state.hidden = false;
    }
  }

  function findGameWindow(root) {
    const seen = new Set();

    function visit(view, depth) {
      if (!view || depth > 8 || seen.has(view)) return null;
      seen.add(view);

      try {
        if (
          view.__hkLazyStats &&
          view.__hkUnityInstance &&
          view.__hkUnityInstance.Module
        ) {
          return view;
        }
      } catch (_) {}

      let count = 0;

      try {
        count = view.frames.length;
      } catch (_) {
        return null;
      }

      for (let index = 0; index < count; index += 1) {
        try {
          const found = visit(view.frames[index], depth + 1);
          if (found) return found;
        } catch (_) {}
      }

      return null;
    }

    return visit(root, 0);
  }

  async function waitForGameWindow(timeoutMs) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const found = findGameWindow(window);
      if (found) return found;

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return null;
  }

  async function loadMap() {
    setBadge(
      'HK auto preload: loading map…',
      VERSION
    );

    const response = await fetch(
      MAP_URL + '?auto=' + Date.now(),
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(
        'preload map HTTP ' + response.status
      );
    }

    const map = await response.json();

    if (
      !map ||
      !map._meta ||
      !map.scenes ||
      typeof map.scenes !== 'object'
    ) {
      throw new Error('preload map is malformed');
    }

    state.map = map;
    state.resourceToScene.clear();

    for (const [sceneName, record] of Object.entries(map.scenes)) {
      if (record && record.resourceFile) {
        const base =
          String(record.resourceFile).split('/').pop();

        state.resourceToScene.set(
          base,
          sceneName
        );
      }
    }
  }

  function getSceneRecord(sceneName) {
    return (
      state.map &&
      state.map.scenes &&
      state.map.scenes[sceneName]
    ) || null;
  }

  function cancelWarmQueue() {
    state.warmGeneration += 1;

    if (state.warmController) {
      try {
        state.warmController.abort();
      } catch (_) {}
    }

    state.warmController = null;
    state.activeWarmParts.clear();
  }

  function orderedNeighborParts(sceneName) {
    const record = getSceneRecord(sceneName);

    if (!record) return [];

    const neighbors = Array.isArray(record.neighbors)
      ? record.neighbors
      : [];

    const seen = new Set();
    const parts = [];

    for (const neighbor of neighbors) {
      const target = getSceneRecord(neighbor);

      if (
        !target ||
        !Array.isArray(target.directPreloadChunks)
      ) {
        continue;
      }

      for (const rawPart of target.directPreloadChunks) {
        const part = Number(rawPart);

        if (
          !Number.isInteger(part) ||
          part < 1 ||
          part > PART_COUNT ||
          seen.has(part)
        ) {
          continue;
        }

        seen.add(part);
        parts.push(part);
      }
    }

    return parts;
  }

  async function warmPart(part, signal) {
    const response = await fetch(
      CHUNK_BASE + part,
      {
        cache: 'force-cache',
        signal
      }
    );

    if (!response.ok) {
      throw new Error(
        'part ' +
        part +
        ' HTTP ' +
        response.status
      );
    }

    let body = await response.arrayBuffer();
    body = null;
  }

  async function warmNeighbors(sceneName) {
    cancelWarmQueue();

    const generation = state.warmGeneration;
    const parts = orderedNeighborParts(sceneName);

    if (!parts.length) {
      setBadge(
        'HK auto preload: ready',
        sceneName + ' · no mapped neighbor chunks'
      );
      return;
    }

    const pending = parts.filter(
      part => !state.warmedParts.has(part)
    );

    if (!pending.length) {
      setBadge(
        'HK auto preload: ready',
        sceneName +
        ' · ' +
        parts.length +
        ' neighbor chunks already warmed'
      );
      return;
    }

    const controller = new AbortController();
    state.warmController = controller;

    let nextIndex = 0;
    let completed = 0;

    setBadge(
      'HK auto preload: warming neighbors',
      sceneName +
      ' · 0 / ' +
      pending.length +
      ' chunks'
    );

    async function worker() {
      while (
        generation === state.warmGeneration &&
        !controller.signal.aborted
      ) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= pending.length) return;

        const part = pending[index];

        state.activeWarmParts.add(part);

        try {
          await warmPart(
            part,
            controller.signal
          );

          if (
            generation !== state.warmGeneration ||
            controller.signal.aborted
          ) {
            return;
          }

          state.warmedParts.add(part);
          completed += 1;

          setBadge(
            'HK auto preload: warming neighbors',
            sceneName +
            ' · ' +
            completed +
            ' / ' +
            pending.length +
            ' chunks'
          );

        } catch (error) {
          if (
            controller.signal.aborted ||
            generation !== state.warmGeneration
          ) {
            return;
          }

          console.warn(
            'HK auto preload part failed:',
            part,
            error
          );

        } finally {
          state.activeWarmParts.delete(part);
        }
      }
    }

    const workers = [];

    for (
      let index = 0;
      index < Math.min(
        PRELOAD_CONCURRENCY,
        pending.length
      );
      index += 1
    ) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (
      generation !== state.warmGeneration ||
      controller.signal.aborted
    ) {
      return;
    }

    state.warmController = null;

    setBadge(
      'HK auto preload: ready',
      sceneName +
      ' · warmed ' +
      completed +
      ' new chunk' +
      (completed === 1 ? '' : 's')
    );
  }

  function setCurrentScene(sceneName, source) {
    if (!getSceneRecord(sceneName)) return false;

    const changed =
      state.currentScene !== sceneName;

    state.currentScene = sceneName;
    state.currentSource = source || '';
    state.detectedAt = performance.now();

    state.recentDataReads.length = 0;
    state.candidateScene = '';
    state.candidateHits = 0;

    if (changed) {
      setBadge(
        'HK auto preload: detected ' + sceneName,
        source || 'room detected'
      );

      warmNeighbors(sceneName).catch(error => {
        console.warn(
          'HK auto preload queue failed:',
          error
        );

        setBadge(
          'HK auto preload: preload error',
          errorText(error)
        );
      });
    }

    return true;
  }

  function installLastFileHook(stats) {
    const descriptor =
      Object.getOwnPropertyDescriptor(
        stats,
        'lastFile'
      );

    if (
      descriptor &&
      descriptor.configurable === false
    ) {
      return;
    }

    let currentValue = stats.lastFile || '';

    Object.defineProperty(
      stats,
      'lastFile',
      {
        configurable: true,
        enumerable: true,

        get() {
          return currentValue;
        },

        set(value) {
          currentValue = value;

          const base =
            String(value || '')
              .split('/')
              .pop();

          const scene =
            state.resourceToScene.get(base);

          if (scene) {
            setCurrentScene(
              scene,
              'exact: ' + base
            );
          }
        }
      }
    );

    state.lastFileRestore = () => {
      try {
        Object.defineProperty(
          stats,
          'lastFile',
          {
            configurable: true,
            enumerable: true,
            writable: true,
            value: currentValue
          }
        );
      } catch (_) {}
    };

    const initialBase =
      String(currentValue || '')
        .split('/')
        .pop();

    const initialScene =
      state.resourceToScene.get(initialBase);

    if (initialScene) {
      setCurrentScene(
        initialScene,
        'exact: ' + initialBase
      );
    }
  }

  function partsForDataRange(position, length) {
    if (
      !state.map ||
      !state.map._meta ||
      !Number.isFinite(position) ||
      !Number.isFinite(length) ||
      length <= 0
    ) {
      return [];
    }

    const dataOffset =
      Number(
        state.map._meta.dataUnity3dOuterOffset
      );

    if (!Number.isFinite(dataOffset)) {
      return [];
    }

    const absoluteStart =
      dataOffset + position;

    const absoluteEnd =
      absoluteStart + length;

    const first =
      Math.floor(
        absoluteStart / PART_SIZE
      ) + 1;

    const last =
      Math.floor(
        (absoluteEnd - 1) / PART_SIZE
      ) + 1;

    const parts = [];

    for (
      let part = first;
      part <= last;
      part += 1
    ) {
      if (
        part >= 1 &&
        part <= PART_COUNT
      ) {
        parts.push(part);
      }
    }

    return parts;
  }

  function recordDataRead(position, length) {
    if (!state.currentScene) return;

    const parts =
      partsForDataRange(
        Number(position),
        Number(length)
      );

    if (!parts.length) return;

    const now = performance.now();

    state.recentDataReads.push({
      time: now,
      parts
    });

    const cutoff =
      now - RECENT_READ_WINDOW_MS;

    while (
      state.recentDataReads.length &&
      state.recentDataReads[0].time < cutoff
    ) {
      state.recentDataReads.shift();
    }

    scheduleInference();
  }

  function recentReadParts() {
    const result = new Set();
    const now = performance.now();
    const cutoff =
      now - RECENT_READ_WINDOW_MS;

    for (const item of state.recentDataReads) {
      if (item.time < cutoff) continue;

      for (const part of item.parts) {
        result.add(part);
      }
    }

    return result;
  }

  function inferNeighborScene() {
    if (
      !state.currentScene ||
      !state.map
    ) {
      return;
    }

    const current =
      getSceneRecord(
        state.currentScene
      );

    if (
      !current ||
      !Array.isArray(current.neighbors) ||
      !current.neighbors.length
    ) {
      return;
    }

    const observed =
      recentReadParts();

    if (!observed.size) return;

    const currentParts =
      new Set(
        Array.isArray(current.dataUnity3dChunks)
          ? current.dataUnity3dChunks.map(Number)
          : []
      );

    const scored = [];

    for (const neighbor of current.neighbors) {
      const record =
        getSceneRecord(neighbor);

      if (
        !record ||
        !Array.isArray(
          record.dataUnity3dChunks
        )
      ) {
        continue;
      }

      const targetParts =
        new Set(
          record.dataUnity3dChunks.map(Number)
        );

      let overlap = 0;
      let evidence = 0;

      for (const part of observed) {
        if (!targetParts.has(part)) continue;

        overlap += 1;

        if (!currentParts.has(part)) {
          evidence += 1;
        }
      }

      const score =
        evidence * 5 + overlap;

      if (score > 0) {
        scored.push({
          scene: neighbor,
          score,
          evidence,
          overlap
        });
      }
    }

    if (!scored.length) return;

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.evidence - a.evidence ||
        b.overlap - a.overlap
    );

    const best = scored[0];
    const second = scored[1];

    const sufficientlyDistinct =
      best.evidence >= 1 ||
      best.overlap >= 2;

    const sufficientlyAhead =
      !second ||
      best.score >= second.score + 2;

    if (
      !sufficientlyDistinct ||
      !sufficientlyAhead
    ) {
      return;
    }

    if (
      state.candidateScene ===
      best.scene
    ) {
      state.candidateHits += 1;
    } else {
      state.candidateScene =
        best.scene;
      state.candidateHits = 1;
    }

    if (
      state.candidateHits >= 2
    ) {
      setCurrentScene(
        best.scene,
        'inferred from data.unity3d reads'
      );
    }
  }

  function scheduleInference() {
    if (state.candidateTimer) {
      clearTimeout(
        state.candidateTimer
      );
    }

    state.candidateTimer =
      setTimeout(
        () => {
          state.candidateTimer = null;
          inferNeighborScene();
        },
        220
      );
  }

  function installDataReadHook() {
    const FS = state.FS;

    if (
      !FS ||
      typeof FS.lookupPath !== 'function'
    ) {
      throw new Error(
        'Emscripten FS unavailable'
      );
    }

    let node = null;

    for (const path of [
      'data.unity3d',
      '/data.unity3d'
    ]) {
      try {
        node =
          FS.lookupPath(path).node;

        if (node) break;
      } catch (_) {}
    }

    if (
      !node ||
      !node.stream_ops
    ) {
      throw new Error(
        'data.unity3d virtual node not found'
      );
    }

    const ops = node.stream_ops;
    const originalRead = ops.read;
    const originalMmap = ops.mmap;

    if (
      typeof originalRead !== 'function'
    ) {
      throw new Error(
        'data.unity3d read hook unavailable'
      );
    }

    ops.read = function (
      stream,
      buffer,
      offset,
      length,
      position
    ) {
      try {
        recordDataRead(
          position,
          length
        );
      } catch (_) {}

      return originalRead.apply(
        this,
        arguments
      );
    };

    if (
      typeof originalMmap === 'function'
    ) {
      ops.mmap = function (
        stream,
        buffer,
        address,
        length,
        position
      ) {
        try {
          recordDataRead(
            position,
            length
          );
        } catch (_) {}

        return originalMmap.apply(
          this,
          arguments
        );
      };
    }

    state.dataReadRestore = () => {
      try {
        ops.read = originalRead;

        if (
          typeof originalMmap ===
          'function'
        ) {
          ops.mmap = originalMmap;
        }
      } catch (_) {}
    };
  }

  async function attachGame() {
    setBadge(
      'HK auto preload: waiting for game…',
      VERSION
    );

    const gameWindow =
      await waitForGameWindow(120000);

    if (!gameWindow) {
      throw new Error(
        'running Hollow Knight instance not found'
      );
    }

    state.gameWindow = gameWindow;
    state.instance =
      gameWindow.__hkUnityInstance;
    state.module =
      state.instance.Module;
    state.FS =
      state.module.__FS;
    state.stats =
      gameWindow.__hkLazyStats;

    installLastFileHook(
      state.stats
    );

    installDataReadHook();

    if (!state.currentScene) {
      setBadge(
        'HK auto preload: ON',
        'waiting for first room detection'
      );
    }
  }

  function cleanup() {
    cancelWarmQueue();

    if (state.candidateTimer) {
      clearTimeout(
        state.candidateTimer
      );

      state.candidateTimer = null;
    }

    if (state.lastFileRestore) {
      state.lastFileRestore();
      state.lastFileRestore = null;
    }

    if (state.dataReadRestore) {
      state.dataReadRestore();
      state.dataReadRestore = null;
    }

    if (state.badge) {
      state.badge.remove();
      state.badge = null;
      state.badgeMain = null;
      state.badgeSub = null;
    }

    delete window.__hkAutoNeighborPreloadTest;
  }

  window.__hkAutoNeighborPreloadTest = {
    version: VERSION,
    state,

    show() {
      showBadge();
    },

    cleanup
  };

  async function start() {
    createBadge();

    try {
      await loadMap();
      await attachGame();

      if (state.currentScene) {
        setBadge(
          'HK auto preload: ON',
          state.currentScene
        );
      }

    } catch (error) {
      console.error(
        'HK auto preload failed:',
        error
      );

      setBadge(
        'HK auto preload: ERROR',
        errorText(error)
      );
    }
  }

  start();
})();
