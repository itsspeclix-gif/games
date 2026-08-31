(function () {
  'use strict';

  const VERSION = 'neighbor-preload-test-v1';

  const MAP_URL =
    'https://cdn.jsdelivr.net/gh/itsspeclix-gif/games@eda4bcec2c31a5cb6a8126a6ab975fac74ba1df4/' +
    'hollowknight/build/preload-analysis/preload-map.analysis.json';

  // IMPORTANT:
  // These URLs intentionally match the production Hollow Knight URLs exactly.
  // The point of this test is to warm the browser HTTP cache that the later
  // synchronous StabilityFS XHR will use.
  const CHUNK_BASE =
    'https://cdn.jsdelivr.net/gh/itsspeclix-gif/games@main/' +
    'hollowknight/build/data4m/hk.data.part';

  if (
    window.__hkNeighborPreloadTest &&
    typeof window.__hkNeighborPreloadTest.show === 'function'
  ) {
    window.__hkNeighborPreloadTest.show();
    return;
  }

  const state = {
    map: null,
    gameWindow: null,
    stats: null,
    panel: null,
    currentInput: null,
    targetSelect: null,
    statusText: null,
    progressText: null,
    statsText: null,
    detectText: null,
    datalist: null,

    resourceToScene: new Map(),
    sceneNames: [],

    controller: null,
    running: false,
    hidden: false,

    lastDetectedScene: '',
    detectionSource: '',
    warmedParts: new Set(),

    statsRestore: null,
    statsTimer: null
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatMiB(bytes) {
    return (Number(bytes || 0) / 1048576).toFixed(1);
  }

  function formatSeconds(ms) {
    return (Number(ms || 0) / 1000).toFixed(2);
  }

  function setStatus(text) {
    if (state.statusText) state.statusText.textContent = text;
  }

  function setProgress(text) {
    if (state.progressText) state.progressText.textContent = text;
  }

  function findGameWindow(root) {
    const seen = new Set();

    function visit(view, depth) {
      if (!view || depth > 8 || seen.has(view)) return null;
      seen.add(view);

      try {
        if (view.__hkLazyStats) return view;
      } catch (_) {}

      let length = 0;
      try {
        length = view.frames.length;
      } catch (_) {
        return null;
      }

      for (let index = 0; index < length; index += 1) {
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

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = '__hk_neighbor_preload_test_panel';

    panel.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'right:12px',
      'top:12px',
      'width:min(360px,calc(100vw - 24px))',
      'max-height:calc(100vh - 24px)',
      'overflow:auto',
      'box-sizing:border-box',
      'padding:14px',
      'border:1px solid rgba(255,255,255,.22)',
      'border-radius:12px',
      'background:rgba(14,14,22,.96)',
      'color:#fff',
      'font:13px/1.35 system-ui,-apple-system,sans-serif',
      'box-shadow:0 10px 35px rgba(0,0,0,.45)',
      '-webkit-text-size-adjust:100%'
    ].join(';');

    panel.innerHTML = `
      <div style="font-size:16px;font-weight:750;margin-bottom:4px">
        HK neighbor preload test
      </div>

      <div style="opacity:.7;font-size:11px;margin-bottom:10px">
        ${escapeHtml(VERSION)} · production files unchanged
      </div>

      <div id="__hk_np_status"
           style="padding:8px;border-radius:8px;background:rgba(255,255,255,.08);
                  margin-bottom:10px">
        Starting…
      </div>

      <label style="display:block;font-weight:650;margin:8px 0 4px">
        Current room
      </label>

      <input id="__hk_np_current"
             list="__hk_np_scenes"
             autocomplete="off"
             spellcheck="false"
             placeholder="e.g. Crossroads_01"
             style="width:100%;box-sizing:border-box;padding:9px 10px;
                    border-radius:8px;border:1px solid rgba(255,255,255,.2);
                    background:#20202a;color:#fff;font:inherit">

      <datalist id="__hk_np_scenes"></datalist>

      <div id="__hk_np_detect"
           style="opacity:.65;font-size:11px;margin-top:4px">
        Automatic detection: waiting
      </div>

      <label style="display:block;font-weight:650;margin:10px 0 4px">
        Neighbor to test
      </label>

      <select id="__hk_np_target"
              style="width:100%;box-sizing:border-box;padding:9px 10px;
                     border-radius:8px;border:1px solid rgba(255,255,255,.2);
                     background:#20202a;color:#fff;font:inherit">
        <option value="">Choose current room first</option>
      </select>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:11px">
        <button id="__hk_np_warm_target"
                style="padding:10px;border:0;border-radius:8px;font:inherit;
                       font-weight:700;cursor:pointer">
          Warm target
        </button>

        <button id="__hk_np_warm_all"
                style="padding:10px;border:0;border-radius:8px;font:inherit;
                       font-weight:650;cursor:pointer">
          Warm all neighbors
        </button>

        <button id="__hk_np_stop"
                style="padding:9px;border:0;border-radius:8px;font:inherit;
                       cursor:pointer">
          Stop
        </button>

        <button id="__hk_np_hide"
                style="padding:9px;border:0;border-radius:8px;font:inherit;
                       cursor:pointer">
          Hide panel
        </button>
      </div>

      <div id="__hk_np_progress"
           style="margin-top:10px;min-height:36px;padding:8px;border-radius:8px;
                  background:rgba(255,255,255,.06)">
        No warmup running.
      </div>

      <div id="__hk_np_stats"
           style="margin-top:8px;opacity:.75;font-size:11px;white-space:pre-wrap">
      </div>

      <div style="margin-top:9px;opacity:.55;font-size:10px">
        Test method: warm the exact production <code>data4m</code> URLs into
        browser HTTP cache, then let the existing synchronous LazyFS request
        those same URLs during the room transition.
      </div>
    `;

    document.documentElement.appendChild(panel);

    state.panel = panel;
    state.currentInput = panel.querySelector('#__hk_np_current');
    state.targetSelect = panel.querySelector('#__hk_np_target');
    state.statusText = panel.querySelector('#__hk_np_status');
    state.progressText = panel.querySelector('#__hk_np_progress');
    state.statsText = panel.querySelector('#__hk_np_stats');
    state.detectText = panel.querySelector('#__hk_np_detect');
    state.datalist = panel.querySelector('#__hk_np_scenes');

    panel.querySelector('#__hk_np_warm_target')
      .addEventListener('click', warmSelectedTarget);

    panel.querySelector('#__hk_np_warm_all')
      .addEventListener('click', warmAllNeighbors);

    panel.querySelector('#__hk_np_stop')
      .addEventListener('click', stopWarmup);

    panel.querySelector('#__hk_np_hide')
      .addEventListener('click', hidePanel);

    state.currentInput.addEventListener('change', () => {
      selectCurrentScene(state.currentInput.value.trim(), 'manual');
    });

    state.currentInput.addEventListener('input', () => {
      const name = state.currentInput.value.trim();
      if (state.map && state.map.scenes && state.map.scenes[name]) {
        populateTargets(name);
      }
    });
  }

  function showPanel() {
    if (!state.panel) createPanel();
    state.panel.style.display = 'block';
    state.hidden = false;
  }

  function hidePanel() {
    if (state.panel) state.panel.style.display = 'none';
    state.hidden = true;
  }

  async function loadMap() {
    setStatus('Loading preload map…');

    const response = await fetch(
      MAP_URL + '?test=' + Date.now(),
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(
        'Preload map HTTP ' + response.status
      );
    }

    const map = await response.json();

    if (
      !map ||
      !map.scenes ||
      typeof map.scenes !== 'object'
    ) {
      throw new Error('Preload map is malformed');
    }

    state.map = map;
    state.sceneNames = Object.keys(map.scenes).sort();

    state.resourceToScene.clear();

    for (const sceneName of state.sceneNames) {
      const record = map.scenes[sceneName];

      if (record && record.resourceFile) {
        state.resourceToScene.set(
          String(record.resourceFile),
          sceneName
        );
      }
    }

    state.datalist.innerHTML = state.sceneNames
      .map(name => `<option value="${escapeHtml(name)}"></option>`)
      .join('');

    setStatus(
      'Map ready: ' +
      state.sceneNames.length +
      ' scenes. Looking for the running game…'
    );
  }

  function populateTargets(sceneName) {
    if (!state.map || !state.map.scenes) return;

    const record = state.map.scenes[sceneName];

    if (!record) {
      state.targetSelect.innerHTML =
        '<option value="">Unknown current room</option>';
      return;
    }

    const neighbors = Array.isArray(record.neighbors)
      ? record.neighbors.slice()
      : [];

    state.targetSelect.innerHTML = '';

    if (!neighbors.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No mapped neighbors';
      state.targetSelect.appendChild(option);
      return;
    }

    for (const neighbor of neighbors) {
      const option = document.createElement('option');
      option.value = neighbor;

      const chunks =
        record.neighborChunksByScene &&
        Array.isArray(record.neighborChunksByScene[neighbor])
          ? record.neighborChunksByScene[neighbor]
          : (
              state.map.scenes[neighbor] &&
              Array.isArray(
                state.map.scenes[neighbor].directPreloadChunks
              )
                ? state.map.scenes[neighbor].directPreloadChunks
                : []
            );

      option.textContent =
        neighbor +
        ' (' + chunks.length + ' chunk' +
        (chunks.length === 1 ? '' : 's') + ')';

      state.targetSelect.appendChild(option);
    }
  }

  function selectCurrentScene(sceneName, source) {
    if (
      !state.map ||
      !state.map.scenes ||
      !state.map.scenes[sceneName]
    ) {
      return false;
    }

    state.currentInput.value = sceneName;
    state.lastDetectedScene = sceneName;
    state.detectionSource = source || '';

    populateTargets(sceneName);

    if (state.detectText) {
      state.detectText.textContent =
        'Current room: ' +
        sceneName +
        (source ? ' · ' + source : '');
    }

    return true;
  }

  function handleLastFile(fileName) {
    if (!fileName || !state.map) return;

    const exact = state.resourceToScene.get(String(fileName));

    if (exact) {
      selectCurrentScene(
        exact,
        'auto-detected from ' + fileName
      );
      return;
    }

    const basename = String(fileName).split('/').pop();

    const byBase = state.resourceToScene.get(basename);

    if (byBase) {
      selectCurrentScene(
        byBase,
        'auto-detected from ' + basename
      );
    }
  }

  function installLastFileHook(stats) {
    const descriptor =
      Object.getOwnPropertyDescriptor(stats, 'lastFile');

    if (descriptor && descriptor.configurable === false) {
      if (state.detectText) {
        state.detectText.textContent =
          'Automatic detection unavailable; select room manually.';
      }
      return;
    }

    let currentValue = stats.lastFile || '';

    Object.defineProperty(stats, 'lastFile', {
      configurable: true,
      enumerable: true,

      get() {
        return currentValue;
      },

      set(value) {
        currentValue = value;

        try {
          handleLastFile(value);
        } catch (_) {}
      }
    });

    state.statsRestore = () => {
      try {
        Object.defineProperty(stats, 'lastFile', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: currentValue
        });
      } catch (_) {}
    };

    handleLastFile(currentValue);
  }

  async function findAndAttachGame() {
    const gameWindow = await waitForGameWindow(60000);

    if (!gameWindow) {
      setStatus(
        'Game stats not found. Open Hollow Knight from Game Library first, ' +
        'then run this bookmark again.'
      );
      return false;
    }

    state.gameWindow = gameWindow;
    state.stats = gameWindow.__hkLazyStats;

    installLastFileHook(state.stats);

    setStatus(
      'Attached to Hollow Knight. Select the current room if it was not ' +
      'auto-detected.'
    );

    return true;
  }

  function getChunksForTarget(currentScene, targetScene) {
    const current = state.map.scenes[currentScene];

    if (!current) {
      throw new Error(
        'Unknown current scene: ' + currentScene
      );
    }

    if (
      current.neighborChunksByScene &&
      Array.isArray(
        current.neighborChunksByScene[targetScene]
      )
    ) {
      return current.neighborChunksByScene[targetScene].slice();
    }

    const target = state.map.scenes[targetScene];

    if (
      target &&
      Array.isArray(target.directPreloadChunks)
    ) {
      return target.directPreloadChunks.slice();
    }

    throw new Error(
      'No preload chunks mapped for ' + targetScene
    );
  }

  async function warmPart(partNumber, signal) {
    const url = CHUNK_BASE + partNumber;
    const started = performance.now();

    const response = await fetch(url, {
      cache: 'force-cache',
      signal
    });

    if (!response.ok) {
      throw new Error(
        'HTTP ' +
        response.status +
        ' for part ' +
        partNumber
      );
    }

    let buffer = await response.arrayBuffer();
    const bytes = buffer.byteLength;

    // Do not retain the body in JavaScript RAM. Its purpose is browser
    // HTTP-cache warming, not LazyFS RAM residency.
    buffer = null;

    return {
      partNumber,
      bytes,
      ms: performance.now() - started
    };
  }

  async function runWarmup(label, chunks) {
    if (state.running) {
      setProgress(
        'A warmup is already running. Stop it first.'
      );
      return;
    }

    const unique = Array.from(
      new Set(
        chunks
          .map(Number)
          .filter(
            value =>
              Number.isInteger(value) &&
              value >= 1 &&
              value <= 208
          )
      )
    );

    if (!unique.length) {
      setProgress('Nothing to warm for ' + label + '.');
      return;
    }

    state.controller = new AbortController();
    state.running = true;

    const signal = state.controller.signal;

    let completed = 0;
    let bytes = 0;
    let totalMs = 0;

    const before = state.stats
      ? {
          loads: Number(state.stats.syncPartLoads || 0),
          blocked: Number(state.stats.syncBlockedMs || 0)
        }
      : null;

    try {
      for (const partNumber of unique) {
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        setProgress(
          label + '\n' +
          'Warming part ' +
          partNumber +
          ' · ' +
          (completed + 1) +
          ' / ' +
          unique.length
        );

        const result = await warmPart(
          partNumber,
          signal
        );

        completed += 1;
        bytes += result.bytes;
        totalMs += result.ms;
        state.warmedParts.add(partNumber);
      }

      const averageMs =
        completed > 0 ? totalMs / completed : 0;

      let suffix = '';

      if (before && state.stats) {
        suffix =
          '\nLazyFS during warmup: +' +
          (
            Number(state.stats.syncPartLoads || 0) -
            before.loads
          ) +
          ' sync loads, +' +
          (
            (
              Number(state.stats.syncBlockedMs || 0) -
              before.blocked
            ) / 1000
          ).toFixed(2) +
          ' s blocked';
      }

      setProgress(
        'READY: ' + label + '\n' +
        completed +
        ' chunk' +
        (completed === 1 ? '' : 's') +
        ' · ' +
        formatMiB(bytes) +
        ' MiB · avg ' +
        Math.round(averageMs) +
        ' ms/chunk\n' +
        'Now enter that room.' +
        suffix
      );
    } catch (error) {
      if (
        error &&
        error.name === 'AbortError'
      ) {
        setProgress(
          'Warmup stopped after ' +
          completed +
          ' / ' +
          unique.length +
          ' chunks.'
        );
      } else {
        console.error(error);
        setProgress(
          'Warmup failed: ' +
          (
            error && error.message
              ? error.message
              : String(error)
          )
        );
      }
    } finally {
      state.running = false;
      state.controller = null;
    }
  }

  function warmSelectedTarget() {
    if (!state.map) return;

    const current =
      state.currentInput.value.trim();

    const target =
      state.targetSelect.value;

    if (!current || !state.map.scenes[current]) {
      setProgress(
        'Choose the current Hollow Knight room first.'
      );
      return;
    }

    if (!target) {
      setProgress(
        'Choose a mapped neighboring room.'
      );
      return;
    }

    let chunks;

    try {
      chunks = getChunksForTarget(
        current,
        target
      );
    } catch (error) {
      setProgress(error.message);
      return;
    }

    runWarmup(
      current + ' → ' + target,
      chunks
    );
  }

  function warmAllNeighbors() {
    if (!state.map) return;

    const current =
      state.currentInput.value.trim();

    const record =
      state.map.scenes[current];

    if (!record) {
      setProgress(
        'Choose the current Hollow Knight room first.'
      );
      return;
    }

    const chunks =
      Array.isArray(record.neighborPreloadChunks)
        ? record.neighborPreloadChunks
        : [];

    if (chunks.length > 12) {
      const ok = window.confirm(
        current +
        ' has ' +
        chunks.length +
        ' unique neighbor chunks (~' +
        (chunks.length * 4) +
        ' MiB physical data). Warm all of them sequentially?'
      );

      if (!ok) return;
    }

    runWarmup(
      current + ' → all mapped neighbors',
      chunks
    );
  }

  function stopWarmup() {
    if (state.controller) {
      state.controller.abort();
    } else {
      setProgress('No warmup is running.');
    }
  }

  function updateLiveStats() {
    if (!state.statsText) return;

    const stats = state.stats;

    if (!stats) {
      state.statsText.textContent =
        'LazyFS stats: not attached';
      return;
    }

    state.statsText.textContent =
      'LazyFS sync loads: ' +
      Number(stats.syncPartLoads || 0) +
      '\n' +
      'LazyFS sync bytes: ' +
      formatMiB(stats.syncBytes || 0) +
      ' MiB\n' +
      'LazyFS blocked: ' +
      formatSeconds(stats.syncBlockedMs || 0) +
      ' s\n' +
      'LazyFS RAM cache: ' +
      formatMiB(stats.cacheBytes || 0) +
      ' / ' +
      formatMiB(stats.cacheLimit || 0) +
      ' MiB\n' +
      'Last virtual file: ' +
      (stats.lastFile || '(none)') +
      '\n' +
      'Test-warmed parts this session: ' +
      state.warmedParts.size;
  }

  function cleanup() {
    stopWarmup();

    if (state.statsRestore) {
      state.statsRestore();
      state.statsRestore = null;
    }

    if (state.statsTimer) {
      clearInterval(state.statsTimer);
      state.statsTimer = null;
    }

    if (state.panel) {
      state.panel.remove();
      state.panel = null;
    }

    delete window.__hkNeighborPreloadTest;
  }

  window.__hkNeighborPreloadTest = {
    version: VERSION,
    state,

    show() {
      showPanel();
    },

    hide() {
      hidePanel();
    },

    stop() {
      stopWarmup();
    },

    cleanup,

    warm(currentScene, targetScene) {
      if (!state.map) {
        throw new Error('Map has not loaded yet');
      }

      selectCurrentScene(
        currentScene,
        'API/manual'
      );

      state.targetSelect.value =
        targetScene;

      warmSelectedTarget();
    }
  };

  async function start() {
    createPanel();

    try {
      await loadMap();

      state.statsTimer = setInterval(
        updateLiveStats,
        500
      );

      updateLiveStats();

      await findAndAttachGame();
      updateLiveStats();
    } catch (error) {
      console.error(error);

      setStatus(
        'Unable to start test: ' +
        (
          error && error.message
            ? error.message
            : String(error)
        )
      );
    }
  }

  start();
})();
