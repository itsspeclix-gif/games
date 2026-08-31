(function () {
  'use strict';

  const VERSION = 'neighbor-preload-test-v2';

  const MAP_URL =
    'https://cdn.jsdelivr.net/gh/itsspeclix-gif/games@eda4bcec2c31a5cb6a8126a6ab975fac74ba1df4/' +
    'hollowknight/build/preload-analysis/preload-map.analysis.json';

  const CHUNK_BASE =
    'https://cdn.jsdelivr.net/gh/itsspeclix-gif/games@main/' +
    'hollowknight/build/data4m/hk.data.part';

  if (
    window.__hkNeighborPreloadTestV2 &&
    typeof window.__hkNeighborPreloadTestV2.show === 'function'
  ) {
    window.__hkNeighborPreloadTestV2.show();
    return;
  }

  const state = {
    map: null,
    gameWindow: null,
    stats: null,
    panel: null,
    currentInput: null,
    targetSelect: null,
    status: null,
    result: null,
    live: null,
    datalist: null,

    sceneNames: [],
    resourceToScene: new Map(),

    armed: false,
    mode: '',
    routeLabel: '',
    baselineStats: null,
    baselineXhrIndex: 0,

    targetChunks: [],
    warmMeasurements: new Map(),

    xhrLog: [],
    xhrRestore: null,
    lastFileRestore: null,

    warmController: null,
    running: false,
    liveTimer: null
  };

  function fmtMiB(bytes) {
    return (Number(bytes || 0) / 1048576).toFixed(1);
  }

  function fmtSec(ms) {
    return (Number(ms || 0) / 1000).toFixed(2);
  }

  function setStatus(text) {
    if (state.status) state.status.textContent = text;
  }

  function setResult(text) {
    if (state.result) state.result.textContent = text;
  }

  function getStatsSnapshot() {
    const s = state.stats || {};
    return {
      loads: Number(s.syncPartLoads || 0),
      bytes: Number(s.syncBytes || 0),
      blockedMs: Number(s.syncBlockedMs || 0)
    };
  }

  function statDelta(after, before) {
    return {
      loads: after.loads - before.loads,
      bytes: after.bytes - before.bytes,
      blockedMs: after.blockedMs - before.blockedMs
    };
  }

  function parsePartNumber(url) {
    const match = String(url || '').match(/\/hk\.data\.part(\d+)(?:[?#]|$)/);
    return match ? Number(match[1]) : null;
  }

  function findGameWindow(root) {
    const seen = new Set();

    function visit(view, depth) {
      if (!view || depth > 8 || seen.has(view)) return null;
      seen.add(view);

      try {
        if (view.__hkLazyStats) return view;
      } catch (_) {}

      let count = 0;
      try {
        count = view.frames.length;
      } catch (_) {
        return null;
      }

      for (let i = 0; i < count; i += 1) {
        try {
          const found = visit(view.frames[i], depth + 1);
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

  function installXhrObserver(gameWindow) {
    const proto = gameWindow.XMLHttpRequest &&
      gameWindow.XMLHttpRequest.prototype;

    if (!proto) {
      throw new Error('Could not access game XMLHttpRequest');
    }

    if (proto.__hkNeighborV2Observed) return;

    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function (method, url, async) {
      this.__hkNeighborV2Meta = {
        method: String(method || ''),
        url: String(url || ''),
        async: async !== false
      };

      return originalOpen.apply(this, arguments);
    };

    proto.send = function () {
      const meta = this.__hkNeighborV2Meta;
      const started = performance.now();

      try {
        return originalSend.apply(this, arguments);
      } finally {
        if (
          meta &&
          meta.async === false &&
          /\/hk\.data\.part\d+(?:[?#]|$)/.test(meta.url)
        ) {
          state.xhrLog.push({
            time: Date.now(),
            part: parsePartNumber(meta.url),
            url: meta.url,
            ms: performance.now() - started,
            status: Number(this.status || 0)
          });
        }
      }
    };

    proto.__hkNeighborV2Observed = true;

    state.xhrRestore = function () {
      try {
        proto.open = originalOpen;
        proto.send = originalSend;
        delete proto.__hkNeighborV2Observed;
      } catch (_) {}
    };
  }

  function installLastFileHook(stats) {
    const descriptor =
      Object.getOwnPropertyDescriptor(stats, 'lastFile');

    if (descriptor && descriptor.configurable === false) {
      return;
    }

    let value = stats.lastFile || '';

    Object.defineProperty(stats, 'lastFile', {
      configurable: true,
      enumerable: true,

      get() {
        return value;
      },

      set(next) {
        value = next;

        if (!state.map || state.armed) return;

        const base = String(next || '').split('/').pop();
        const scene = state.resourceToScene.get(base);

        if (scene) {
          state.currentInput.value = scene;
          populateTargets(scene);
        }
      }
    });

    state.lastFileRestore = function () {
      try {
        Object.defineProperty(stats, 'lastFile', {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        });
      } catch (_) {}
    };
  }

  function createPanel() {
    const panel = document.createElement('div');

    panel.id = '__hk_neighbor_preload_test_v2_panel';
    panel.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'right:10px',
      'top:10px',
      'width:min(390px,calc(100vw - 20px))',
      'max-height:calc(100vh - 20px)',
      'overflow:auto',
      'box-sizing:border-box',
      'padding:14px',
      'border-radius:12px',
      'border:1px solid rgba(255,255,255,.18)',
      'background:rgba(13,13,21,.97)',
      'color:#fff',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 10px 34px rgba(0,0,0,.5)'
    ].join(';');

    panel.innerHTML = `
      <div style="font-size:17px;font-weight:800">
        HK preload benchmark v2
      </div>

      <div style="opacity:.62;font-size:11px;margin:2px 0 10px">
        ${VERSION} · test-only · production unchanged
      </div>

      <div id="__hk_v2_status"
           style="padding:9px;border-radius:8px;background:rgba(255,255,255,.09);
                  margin-bottom:10px">
        Starting…
      </div>

      <label style="display:block;font-weight:700;margin:7px 0 4px">
        Current room
      </label>

      <input id="__hk_v2_current"
             list="__hk_v2_scenes"
             placeholder="e.g. Town"
             autocomplete="off"
             spellcheck="false"
             style="width:100%;box-sizing:border-box;padding:9px;
                    border-radius:8px;border:1px solid rgba(255,255,255,.2);
                    background:#22222d;color:#fff;font:inherit">

      <datalist id="__hk_v2_scenes"></datalist>

      <label style="display:block;font-weight:700;margin:9px 0 4px">
        Target neighboring room
      </label>

      <select id="__hk_v2_target"
              style="width:100%;box-sizing:border-box;padding:9px;
                     border-radius:8px;border:1px solid rgba(255,255,255,.2);
                     background:#22222d;color:#fff;font:inherit">
        <option value="">Choose current room first</option>
      </select>

      <button id="__hk_v2_preload_arm"
              style="width:100%;margin-top:10px;padding:11px;border:0;
                     border-radius:8px;font:inherit;font-weight:800">
        PRELOAD TARGET + ARM TEST
      </button>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px">
        <button id="__hk_v2_finish"
                style="padding:10px;border:0;border-radius:8px;font:inherit;
                       font-weight:750">
          FINISH TRANSITION
        </button>

        <button id="__hk_v2_reset"
                style="padding:10px;border:0;border-radius:8px;font:inherit">
          Reset test
        </button>
      </div>

      <div id="__hk_v2_result"
           style="margin-top:10px;padding:10px;border-radius:8px;
                  background:rgba(255,255,255,.07);white-space:pre-wrap">
        No test armed.
      </div>

      <div id="__hk_v2_live"
           style="margin-top:8px;opacity:.7;font-size:11px;white-space:pre-wrap">
      </div>

      <div style="margin-top:9px;opacity:.52;font-size:10px">
        Use an unvisited target in a fresh browser session when possible.
        If the target chunks were already cached, this test can still measure
        transition blocking, but it cannot prove how much preload improved it.
      </div>
    `;

    document.documentElement.appendChild(panel);

    state.panel = panel;
    state.currentInput = panel.querySelector('#__hk_v2_current');
    state.targetSelect = panel.querySelector('#__hk_v2_target');
    state.status = panel.querySelector('#__hk_v2_status');
    state.result = panel.querySelector('#__hk_v2_result');
    state.live = panel.querySelector('#__hk_v2_live');
    state.datalist = panel.querySelector('#__hk_v2_scenes');

    state.currentInput.addEventListener('input', () => {
      const scene = state.currentInput.value.trim();
      if (state.map && state.map.scenes[scene]) {
        populateTargets(scene);
      }
    });

    panel.querySelector('#__hk_v2_preload_arm')
      .addEventListener('click', preloadAndArm);

    panel.querySelector('#__hk_v2_finish')
      .addEventListener('click', finishTransition);

    panel.querySelector('#__hk_v2_reset')
      .addEventListener('click', resetTest);
  }

  function showPanel() {
    if (state.panel) {
      state.panel.style.display = 'block';
    }
  }

  function populateTargets(sceneName) {
    if (!state.map || !state.map.scenes) return;

    const record = state.map.scenes[sceneName];
    state.targetSelect.innerHTML = '';

    if (!record) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Unknown room';
      state.targetSelect.appendChild(option);
      return;
    }

    const neighbors = Array.isArray(record.neighbors)
      ? record.neighbors
      : [];

    if (!neighbors.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No mapped neighbors';
      state.targetSelect.appendChild(option);
      return;
    }

    for (const neighbor of neighbors) {
      const target = state.map.scenes[neighbor];
      const chunks =
        target && Array.isArray(target.directPreloadChunks)
          ? target.directPreloadChunks
          : [];

      const option = document.createElement('option');
      option.value = neighbor;
      option.textContent =
        neighbor +
        ' (' + chunks.length + ' mapped chunk' +
        (chunks.length === 1 ? '' : 's') + ')';

      state.targetSelect.appendChild(option);
    }
  }

  async function loadMap() {
    setStatus('Loading room/chunk map…');

    const response = await fetch(
      MAP_URL + '?v2=' + Date.now(),
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error('Map HTTP ' + response.status);
    }

    const map = await response.json();

    if (!map || !map.scenes) {
      throw new Error('Room/chunk map is malformed');
    }

    state.map = map;
    state.sceneNames = Object.keys(map.scenes).sort();

    state.resourceToScene.clear();

    for (const sceneName of state.sceneNames) {
      const rec = map.scenes[sceneName];

      if (rec && rec.resourceFile) {
        state.resourceToScene.set(
          String(rec.resourceFile).split('/').pop(),
          sceneName
        );
      }
    }

    state.datalist.innerHTML =
      state.sceneNames
        .map(name => `<option value="${String(name).replaceAll('"', '&quot;')}"></option>`)
        .join('');
  }

  async function attachGame() {
    setStatus('Looking for the running Hollow Knight instance…');

    const gameWindow = await waitForGameWindow(60000);

    if (!gameWindow) {
      throw new Error(
        'Running Hollow Knight instance not found'
      );
    }

    state.gameWindow = gameWindow;
    state.stats = gameWindow.__hkLazyStats;

    installXhrObserver(gameWindow);
    installLastFileHook(state.stats);

    const currentLastFile =
      String(state.stats.lastFile || '').split('/').pop();

    const detected =
      state.resourceToScene.get(currentLastFile);

    if (detected) {
      state.currentInput.value = detected;
      populateTargets(detected);
    }

    setStatus(
      'Attached. Choose current room + target, then press PRELOAD TARGET + ARM TEST.'
    );
  }

  function getTargetChunks(targetScene) {
    const rec = state.map.scenes[targetScene];

    if (
      !rec ||
      !Array.isArray(rec.directPreloadChunks)
    ) {
      throw new Error(
        'No mapped chunks for target ' + targetScene
      );
    }

    return Array.from(
      new Set(
        rec.directPreloadChunks
          .map(Number)
          .filter(
            n => Number.isInteger(n) && n >= 1 && n <= 208
          )
      )
    );
  }

  async function warmChunk(part, signal) {
    const url = CHUNK_BASE + part;
    const started = performance.now();

    const response = await fetch(url, {
      cache: 'force-cache',
      signal
    });

    if (!response.ok) {
      throw new Error(
        'HTTP ' + response.status + ' for part ' + part
      );
    }

    let body = await response.arrayBuffer();
    const bytes = body.byteLength;
    body = null;

    return {
      part,
      bytes,
      ms: performance.now() - started
    };
  }

  function describeWarmState(measurements) {
    if (!measurements.length) return 'unknown';

    const times = measurements
      .map(item => item.ms)
      .slice()
      .sort((a, b) => a - b);

    const median = times[Math.floor(times.length / 2)];

    if (median <= 60) {
      return 'probably already browser-cached';
    }

    if (median >= 180) {
      return 'network-like / probably not already browser-cached';
    }

    return 'uncertain cache state';
  }

  async function preloadAndArm() {
    if (state.running) return;

    if (state.armed) {
      setResult(
        'A transition test is already armed. Finish or reset it first.'
      );
      return;
    }

    const current = state.currentInput.value.trim();
    const target = state.targetSelect.value;

    if (!state.map.scenes[current]) {
      setResult('Choose a valid current room.');
      return;
    }

    if (!target || !state.map.scenes[target]) {
      setResult('Choose a valid neighboring target room.');
      return;
    }

    let chunks;

    try {
      chunks = getTargetChunks(target);
    } catch (error) {
      setResult(error.message);
      return;
    }

    state.running = true;
    state.warmController = new AbortController();
    state.warmMeasurements.clear();
    state.targetChunks = chunks.slice();
    state.mode = 'preloaded';
    state.routeLabel = current + ' → ' + target;

    const measurements = [];
    let totalBytes = 0;

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const part = chunks[i];

        setResult(
          'Preloading ' + state.routeLabel + '\n' +
          'Part ' + part + ' · ' + (i + 1) + ' / ' + chunks.length
        );

        const measurement = await warmChunk(
          part,
          state.warmController.signal
        );

        measurements.push(measurement);
        totalBytes += measurement.bytes;
        state.warmMeasurements.set(part, measurement);
      }

      const totalWarmMs = measurements.reduce(
        (sum, item) => sum + item.ms,
        0
      );

      const avgWarmMs =
        measurements.length
          ? totalWarmMs / measurements.length
          : 0;

      const cacheDescription =
        describeWarmState(measurements);

      state.baselineStats = getStatsSnapshot();
      state.baselineXhrIndex = state.xhrLog.length;
      state.armed = true;

      setStatus(
        'TEST ARMED. Enter ' + target +
        ', wait until the room is playable, then press FINISH TRANSITION.'
      );

      setResult(
        'PRELOAD COMPLETE\n' +
        state.routeLabel + '\n' +
        'Mapped chunks: ' + chunks.join(', ') + '\n' +
        'Fetched: ' + fmtMiB(totalBytes) + ' MiB\n' +
        'Average warm fetch: ' + Math.round(avgWarmMs) + ' ms/chunk\n' +
        'Cache indication: ' + cacheDescription + '\n\n' +
        'Now enter ' + target + '.'
      );

    } catch (error) {
      setResult(
        'Preload failed: ' +
        (error && error.message ? error.message : String(error))
      );

      state.targetChunks = [];
      state.warmMeasurements.clear();
      state.mode = '';
      state.routeLabel = '';
    } finally {
      state.running = false;
      state.warmController = null;
    }
  }

  function finishTransition() {
    if (!state.armed || !state.baselineStats) {
      setResult(
        'No transition test is armed. Press PRELOAD TARGET + ARM TEST first.'
      );
      return;
    }

    const after = getStatsSnapshot();
    const delta = statDelta(
      after,
      state.baselineStats
    );

    const requests =
      state.xhrLog.slice(state.baselineXhrIndex);

    const partRequests =
      requests.filter(item => Number.isInteger(item.part));

    const requestedParts =
      Array.from(
        new Set(partRequests.map(item => item.part))
      );

    const targetSet =
      new Set(state.targetChunks);

    const mappedRequested =
      requestedParts.filter(part => targetSet.has(part));

    const extraRequested =
      requestedParts.filter(part => !targetSet.has(part));

    let mappedSyncMs = 0;
    let extraSyncMs = 0;

    for (const req of partRequests) {
      if (targetSet.has(req.part)) {
        mappedSyncMs += req.ms;
      } else {
        extraSyncMs += req.ms;
      }
    }

    let approximateAvoidedMs = 0;

    for (const req of partRequests) {
      if (!targetSet.has(req.part)) continue;

      const warm = state.warmMeasurements.get(req.part);

      if (warm) {
        approximateAvoidedMs += Math.max(
          0,
          warm.ms - req.ms
        );
      }
    }

    let verdict;

    if (delta.blockedMs <= 3000) {
      verdict = 'GOOD: transition blocking is under 3 s.';
    } else if (delta.blockedMs <= 7000) {
      verdict = 'PARTIAL: improved enough to be usable, but still above the ideal.';
    } else {
      verdict = 'INCOMPLETE: too much blocking remains; more dependencies must be preloaded.';
    }

    const cacheNote =
      describeWarmState(
        Array.from(state.warmMeasurements.values())
      );

    setStatus(
      'Test finished. Reset before testing another route.'
    );

    setResult(
      'RESULT — ' + state.routeLabel + '\n\n' +
      'Transition delta:\n' +
      '  sync loads: +' + delta.loads + '\n' +
      '  sync bytes: +' + fmtMiB(delta.bytes) + ' MiB\n' +
      '  blocked: +' + fmtSec(delta.blockedMs) + ' s\n\n' +

      'Observed synchronous chunk requests:\n' +
      '  unique parts: ' +
      (requestedParts.length ? requestedParts.join(', ') : '(none observed)') +
      '\n' +
      '  mapped target parts reused: ' +
      mappedRequested.length + ' / ' + state.targetChunks.length +
      '\n' +
      '  extra/unmapped parts: ' +
      (extraRequested.length ? extraRequested.join(', ') : '(none)') +
      '\n\n' +

      'XHR wait inside transition:\n' +
      '  mapped target parts: ' + fmtSec(mappedSyncMs) + ' s\n' +
      '  extra parts: ' + fmtSec(extraSyncMs) + ' s\n\n' +

      'Preload cache indication: ' + cacheNote + '\n' +
      'Approx. network wait avoided on mapped parts: ' +
      fmtSec(approximateAvoidedMs) + ' s\n\n' +

      verdict + '\n\n' +

      'Important: if preload cache indication says "probably already browser-cached", ' +
      'this run cannot prove the preload caused the speedup. Use an unvisited room ' +
      'in a fresh/private browser session for the cleanest comparison.'
    );

    state.armed = false;
  }

  function resetTest() {
    if (state.warmController) {
      try {
        state.warmController.abort();
      } catch (_) {}
    }

    state.armed = false;
    state.running = false;
    state.mode = '';
    state.routeLabel = '';
    state.baselineStats = null;
    state.baselineXhrIndex = state.xhrLog.length;
    state.targetChunks = [];
    state.warmMeasurements.clear();

    setStatus(
      'Reset. Choose the actual current room and a neighboring target.'
    );

    setResult('No test armed.');
  }

  function updateLive() {
    if (!state.live || !state.stats) return;

    state.live.textContent =
      'Cumulative LazyFS (reference only):\n' +
      'sync loads: ' + Number(state.stats.syncPartLoads || 0) + '\n' +
      'sync bytes: ' + fmtMiB(state.stats.syncBytes || 0) + ' MiB\n' +
      'blocked: ' + fmtSec(state.stats.syncBlockedMs || 0) + ' s\n' +
      'RAM cache: ' + fmtMiB(state.stats.cacheBytes || 0) +
      ' / ' + fmtMiB(state.stats.cacheLimit || 0) + ' MiB\n' +
      'last outer file: ' + (state.stats.lastFile || '(none)');
  }

  function cleanup() {
    try {
      if (state.warmController) state.warmController.abort();
    } catch (_) {}

    if (state.liveTimer) {
      clearInterval(state.liveTimer);
      state.liveTimer = null;
    }

    if (state.xhrRestore) {
      state.xhrRestore();
      state.xhrRestore = null;
    }

    if (state.lastFileRestore) {
      state.lastFileRestore();
      state.lastFileRestore = null;
    }

    if (state.panel) {
      state.panel.remove();
      state.panel = null;
    }

    delete window.__hkNeighborPreloadTestV2;
  }

  window.__hkNeighborPreloadTestV2 = {
    version: VERSION,
    state,
    show: showPanel,
    reset: resetTest,
    cleanup
  };

  async function start() {
    createPanel();

    try {
      await loadMap();
      await attachGame();

      state.liveTimer = setInterval(
        updateLive,
        500
      );

      updateLive();
    } catch (error) {
      console.error(error);

      setStatus(
        'Unable to start benchmark: ' +
        (error && error.message ? error.message : String(error))
      );
    }
  }

  start();
})();
