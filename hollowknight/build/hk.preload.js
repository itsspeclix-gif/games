(function () {
  'use strict';

  const DEFAULT_PART_SIZE = 4 * 1024 * 1024;
  const DEFAULT_CONCURRENCY = 1;
  const DEFAULT_READ_WINDOW_MS = 1800;

  if (window.installHollowKnightNeighborPreload) return;

  window.installHollowKnightNeighborPreload = async function (
    instance,
    options = {}
  ) {
    if (window.__hkNeighborPreload) {
      return window.__hkNeighborPreload;
    }

    if (!instance || !instance.Module) {
      throw new Error('Hollow Knight Unity instance is unavailable');
    }

    const module = instance.Module;
    const FS = module.__FS;
    const stats = window.__hkLazyStats;

    if (!FS || typeof FS.lookupPath !== 'function') {
      throw new Error('Hollow Knight Emscripten FS is unavailable');
    }

    if (!stats) {
      throw new Error('Hollow Knight LazyFS stats are unavailable');
    }

    const mapUrl =
      options.mapUrl ||
      'build/preload-analysis/preload-map.analysis.json';

    const partSize =
      Number(options.partSize) || DEFAULT_PART_SIZE;

    const preloadConcurrency = Math.max(
      1,
      Number(options.preloadConcurrency) || DEFAULT_CONCURRENCY
    );

    const recentReadWindowMs = Math.max(
      250,
      Number(options.recentReadWindowMs) || DEFAULT_READ_WINDOW_MS
    );

    const dataPartUrls = Array.isArray(options.dataPartUrls)
      ? options.dataPartUrls.slice()
      : Array.from(
          { length: 208 },
          (_, index) => 'build/data4m/hk.data.part' + (index + 1)
        );

    const partCount = dataPartUrls.length;

    const mapResponse = await fetch(mapUrl, {
      cache: 'force-cache'
    });

    if (!mapResponse.ok) {
      throw new Error(
        'Could not load Hollow Knight preload map (' +
        mapResponse.status +
        ')'
      );
    }

    const map = await mapResponse.json();

    if (
      !map ||
      !map._meta ||
      !map.scenes ||
      typeof map.scenes !== 'object'
    ) {
      throw new Error('Hollow Knight preload map is malformed');
    }

    const state = {
      currentScene: '',
      currentSource: '',
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
      dataReadRestore: null
    };

    function getSceneRecord(sceneName) {
      return map.scenes[sceneName] || null;
    }

    for (const [sceneName, record] of Object.entries(map.scenes)) {
      if (record && record.resourceFile) {
        const base = String(record.resourceFile).split('/').pop();
        state.resourceToScene.set(base, sceneName);
      }
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
            part > partCount ||
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
      const url = dataPartUrls[part - 1];
      if (!url) return;

      const response = await fetch(url, {
        cache: 'force-cache',
        signal
      });

      if (!response.ok) {
        throw new Error(
          'preload part ' + part + ' HTTP ' + response.status
        );
      }

      // Drain the response without materializing the whole 4 MiB chunk
      // as one ArrayBuffer. This keeps transient JS memory much lower on Safari.
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();

        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch (_) {}
        }
      } else {
        // Fallback for browsers without ReadableStream support.
        await response.arrayBuffer();
      }
    }

    async function warmNeighbors(sceneName) {
      cancelWarmQueue();

      const generation = state.warmGeneration;
      const parts = orderedNeighborParts(sceneName);
      const pending = parts.filter(
        part => !state.warmedParts.has(part)
      );

      if (!pending.length) return;

      const controller = new AbortController();
      state.warmController = controller;

      let nextIndex = 0;

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
            await warmPart(part, controller.signal);

            if (
              generation !== state.warmGeneration ||
              controller.signal.aborted
            ) {
              return;
            }

            state.warmedParts.add(part);
          } catch (error) {
            if (
              controller.signal.aborted ||
              generation !== state.warmGeneration
            ) {
              return;
            }

            console.warn(
              'Hollow Knight neighbor preload failed for part ' + part,
              error
            );
          } finally {
            state.activeWarmParts.delete(part);
          }
        }
      }

      const workers = [];
      const workerCount = Math.min(
        preloadConcurrency,
        pending.length
      );

      for (let index = 0; index < workerCount; index += 1) {
        workers.push(worker());
      }

      await Promise.all(workers);

      if (
        generation === state.warmGeneration &&
        !controller.signal.aborted
      ) {
        state.warmController = null;
      }
    }

    function setCurrentScene(sceneName, source) {
      if (!getSceneRecord(sceneName)) return false;

      const changed = state.currentScene !== sceneName;

      state.currentScene = sceneName;
      state.currentSource = source || '';
      state.recentDataReads.length = 0;
      state.candidateScene = '';
      state.candidateHits = 0;

      if (changed) {
        warmNeighbors(sceneName).catch(error => {
          console.warn('Hollow Knight neighbor preload queue failed', error);
        });
      }

      return true;
    }

    function installLastFileHook() {
      const descriptor = Object.getOwnPropertyDescriptor(
        stats,
        'lastFile'
      );

      if (descriptor && descriptor.configurable === false) {
        return;
      }

      let currentValue = stats.lastFile || '';

      function inspect(value) {
        const base = String(value || '').split('/').pop();
        const scene = state.resourceToScene.get(base);

        if (scene) {
          setCurrentScene(scene, 'resource');
        }
      }

      Object.defineProperty(stats, 'lastFile', {
        configurable: true,
        enumerable: true,
        get() {
          return currentValue;
        },
        set(value) {
          currentValue = value;
          inspect(value);
        }
      });

      state.lastFileRestore = () => {
        try {
          Object.defineProperty(stats, 'lastFile', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: currentValue
          });
        } catch (_) {}
      };

      inspect(currentValue);
    }

    function partsForDataRange(position, length) {
      if (
        !Number.isFinite(position) ||
        !Number.isFinite(length) ||
        length <= 0
      ) {
        return [];
      }

      const dataOffset = Number(map._meta.dataUnity3dOuterOffset);
      if (!Number.isFinite(dataOffset)) return [];

      const absoluteStart = dataOffset + position;
      const absoluteEnd = absoluteStart + length;

      const first = Math.floor(absoluteStart / partSize) + 1;
      const last = Math.floor((absoluteEnd - 1) / partSize) + 1;
      const parts = [];

      for (let part = first; part <= last; part += 1) {
        if (part >= 1 && part <= partCount) {
          parts.push(part);
        }
      }

      return parts;
    }

    function recordDataRead(position, length) {
      if (!state.currentScene) return;

      const parts = partsForDataRange(
        Number(position),
        Number(length)
      );

      if (!parts.length) return;

      const now = performance.now();

      state.recentDataReads.push({
        time: now,
        parts
      });

      const cutoff = now - recentReadWindowMs;

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
      const cutoff = performance.now() - recentReadWindowMs;

      for (const item of state.recentDataReads) {
        if (item.time < cutoff) continue;

        for (const part of item.parts) {
          result.add(part);
        }
      }

      return result;
    }

    function inferNeighborScene() {
      if (!state.currentScene) return;

      const current = getSceneRecord(state.currentScene);

      if (
        !current ||
        !Array.isArray(current.neighbors) ||
        !current.neighbors.length
      ) {
        return;
      }

      const observed = recentReadParts();
      if (!observed.size) return;

      const currentParts = new Set(
        Array.isArray(current.dataUnity3dChunks)
          ? current.dataUnity3dChunks.map(Number)
          : []
      );

      const scored = [];

      for (const neighbor of current.neighbors) {
        const record = getSceneRecord(neighbor);

        if (
          !record ||
          !Array.isArray(record.dataUnity3dChunks)
        ) {
          continue;
        }

        const targetParts = new Set(
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

        const score = evidence * 5 + overlap;

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
        best.evidence >= 1 || best.overlap >= 2;

      const sufficientlyAhead =
        !second || best.score >= second.score + 2;

      if (!sufficientlyDistinct || !sufficientlyAhead) {
        return;
      }

      if (state.candidateScene === best.scene) {
        state.candidateHits += 1;
      } else {
        state.candidateScene = best.scene;
        state.candidateHits = 1;
      }

      if (state.candidateHits >= 2) {
        setCurrentScene(best.scene, 'data-read');
      }
    }

    function scheduleInference() {
      if (state.candidateTimer) {
        clearTimeout(state.candidateTimer);
      }

      state.candidateTimer = setTimeout(() => {
        state.candidateTimer = null;
        inferNeighborScene();
      }, 220);
    }

    function installDataReadHook() {
      let node = null;

      for (const path of ['data.unity3d', '/data.unity3d']) {
        try {
          node = FS.lookupPath(path).node;
          if (node) break;
        } catch (_) {}
      }

      if (!node || !node.stream_ops) {
        throw new Error('Hollow Knight data.unity3d node was not found');
      }

      const ops = node.stream_ops;
      const originalRead = ops.read;
      const originalMmap = ops.mmap;

      if (typeof originalRead !== 'function') {
        throw new Error('Hollow Knight data.unity3d read hook is unavailable');
      }

      ops.read = function (
        stream,
        buffer,
        offset,
        length,
        position
      ) {
        try {
          recordDataRead(position, length);
        } catch (_) {}

        return originalRead.apply(this, arguments);
      };

      if (typeof originalMmap === 'function') {
        ops.mmap = function (
          stream,
          buffer,
          address,
          length,
          position
        ) {
          try {
            recordDataRead(position, length);
          } catch (_) {}

          return originalMmap.apply(this, arguments);
        };
      }

      state.dataReadRestore = () => {
        try {
          ops.read = originalRead;

          if (typeof originalMmap === 'function') {
            ops.mmap = originalMmap;
          }
        } catch (_) {}
      };
    }

    try {
      installLastFileHook();
      installDataReadHook();
    } catch (error) {
      if (state.lastFileRestore) {
        state.lastFileRestore();
        state.lastFileRestore = null;
      }

      if (state.dataReadRestore) {
        state.dataReadRestore();
        state.dataReadRestore = null;
      }

      cancelWarmQueue();
      throw error;
    }

    const controller = {
      version: '1.1.0',
      state,
      cleanup() {
        cancelWarmQueue();

        if (state.candidateTimer) {
          clearTimeout(state.candidateTimer);
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

        if (window.__hkNeighborPreload === controller) {
          delete window.__hkNeighborPreload;
        }
      }
    };

    window.__hkNeighborPreload = controller;
    return controller;
  };
})();
