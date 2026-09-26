(function () {
  'use strict';

  const BUILD_VERSION = '2026.09.25-r3';
  const DEFAULT_PART_SIZE = 4 * 1024 * 1024;
  const DEFAULT_READ_WINDOW_MS = 1800;
  const WARM_TTL_MS = 120000;
  const RETRY_COOLDOWN_MS = 15000;
  const REQUEST_TIMEOUT_MS = 30000;
  const MAX_RECENT_READS = 128;
  const MAX_LEARNED_PARTS = 16;
  const preloadFetch = window.fetch.bind(window);

  if (window.installHollowKnightNeighborPreload) return;
  window.__hkPreloadVersion = BUILD_VERSION;

  // Decode ONLY the small UnityFS block-info table, not any game assets.
  // Block format: https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
  function decodeLZ4(input, size) {
    const output = new Uint8Array(size);
    let source = 0, target = 0;
    while (source < input.length) {
      const token = input[source++];
      let literals = token >>> 4;
      if (literals === 15) {
        let extra;
        do {
          if (source >= input.length) throw new Error('Truncated LZ4 literal length');
          extra = input[source++];
          literals += extra;
        } while (extra === 255);
      }
      if (source + literals > input.length || target + literals > size) {
        throw new Error('Invalid LZ4 literal extent');
      }
      output.set(input.subarray(source, source + literals), target);
      source += literals;
      target += literals;
      if (source === input.length) break;
      if (source + 2 > input.length) throw new Error('Truncated LZ4 match offset');
      const distance = input[source] | (input[source + 1] << 8);
      source += 2;
      if (!distance || distance > target) throw new Error('Invalid LZ4 match offset');
      let count = (token & 15) + 4;
      if ((token & 15) === 15) {
        let extra;
        do {
          if (source >= input.length) throw new Error('Truncated LZ4 match length');
          extra = input[source++];
          count += extra;
        } while (extra === 255);
      }
      if (target + count > size) throw new Error('Invalid LZ4 match extent');
      // Forward copy is necessary for overlapping LZ4 matches.
      for (let index = 0; index < count; index += 1) {
        output[target] = output[target - distance];
        target += 1;
      }
    }
    if (target !== size) throw new Error('Incorrect LZ4 decoded size');
    return output;
  }

  function buildSceneRanges(FS, map) {
    const meta = map._meta.unityFS;
    const node = FS.lookupPath('data.unity3d').node;
    if (!meta || node.usedBytes !== map._meta.dataUnity3dSize ||
        (meta.archiveFlags & 128) || !Number.isSafeInteger(meta.compressedInfoSize) ||
        !Number.isSafeInteger(meta.uncompressedInfoSize) ||
        meta.compressedInfoSize <= 0 || meta.compressedInfoSize > 2 * 1024 * 1024 ||
        meta.uncompressedInfoSize < 20 || meta.uncompressedInfoSize > 2 * 1024 * 1024 ||
        !Number.isSafeInteger(meta.dataStart) || meta.dataStart < meta.compressedInfoSize ||
        meta.dataStart > node.usedBytes) {
      throw new Error('Unsupported or mismatched UnityFS preload metadata');
    }
    const compressed = new Uint8Array(meta.compressedInfoSize);
    const stream = FS.open('data.unity3d', 'r');
    try {
      const count = FS.read(stream, compressed, 0, compressed.length,
        meta.dataStart - meta.compressedInfoSize);
      if (count !== compressed.length) throw new Error('Truncated UnityFS block-info table');
    } finally {
      FS.close(stream);
    }
    const compression = meta.archiveFlags & 63;
    if (compression !== 0 && compression !== 2 && compression !== 3) {
      throw new Error('Unsupported UnityFS block-info compression ' + compression);
    }
    const table = compression === 0 ? compressed : decodeLZ4(compressed, meta.uncompressedInfoSize);
    if (table.length !== meta.uncompressedInfoSize) throw new Error('Incorrect UnityFS table size');
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const count = view.getUint32(16, false);
    if (count !== meta.blockCount || 20 + count * 10 > table.length) {
      throw new Error('Incorrect UnityFS block count');
    }
    const offsets = new Uint32Array(count + 1);
    const decodedOffsets = new Float64Array(count + 1);
    const owners = new Uint16Array(count);
    offsets[0] = meta.dataStart;
    for (let index = 0; index < count; index += 1) {
      const end = offsets[index] + view.getUint32(24 + index * 10, false);
      if (end > node.usedBytes) throw new Error('UnityFS compressed block outside bundle');
      offsets[index + 1] = end;
      decodedOffsets[index + 1] = decodedOffsets[index] + view.getUint32(20 + index * 10, false);
    }
    if (offsets[count] !== meta.compressedBlocksEnd) {
      throw new Error('UnityFS block offsets do not match preload map');
    }
    const names = Object.keys(map.scenes);
    if (names.length >= 65535) throw new Error('Too many scene markers');
    const levelNames = new Map(names.map((name, index) => [map.scenes[name].levelFile, index + 1]));
    let position = 20 + count * 10;
    if (position + 4 > table.length || view.getUint32(position, false) !== meta.nodeCount) {
      throw new Error('Incorrect UnityFS node count');
    }
    position += 4;
    let mappedLevels = 0;
    for (let item = 0; item < meta.nodeCount; item += 1) {
      if (position + 20 > table.length) throw new Error('Truncated UnityFS node');
      const start = view.getUint32(position, false) * 4294967296 + view.getUint32(position + 4, false);
      const size = view.getUint32(position + 8, false) * 4294967296 + view.getUint32(position + 12, false);
      position += 20;
      let name = '';
      while (position < table.length && table[position] !== 0) name += String.fromCharCode(table[position++]);
      if (position === table.length) throw new Error('Unterminated UnityFS filename');
      position += 1;
      if (!Number.isSafeInteger(start + size) || start + size > decodedOffsets[count]) {
        throw new Error('UnityFS node outside decoded bundle');
      }
      const owner = levelNames.get(name);
      if (!owner) continue;
      mappedLevels += 1;
      let low = 0, high = count;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (decodedOffsets[middle] < start) low = middle + 1; else high = middle;
      }
      // Use only blocks wholly inside the level file. Boundary blocks can also
      // contain another scene's assets and are deliberately NOT exact markers.
      for (let block = low; block < count && decodedOffsets[block + 1] <= start + size; block += 1) {
        owners[block] = owners[block] === 0 || owners[block] === owner ? owner : 65535;
      }
    }
    if (mappedLevels !== names.length) throw new Error('Scene map does not match UnityFS level files');
    const ranges = [];
    for (let index = 0; index < count; index += 1) {
      const owner = owners[index];
      // A block shared by two level files is NOT an exact scene signal.
      if (!owner || owner === 65535) continue;
      const start = offsets[index];
      const scene = names[owner - 1];
      const previous = ranges[ranges.length - 1];
      if (previous && previous.scene === scene && previous.end === start) {
        previous.end = offsets[index + 1];
      } else {
        ranges.push({ start, end: offsets[index + 1], scene });
      }
    }
    return ranges;
  }

  window.installHollowKnightNeighborPreload = async function (instance, options = {}) {
    if (window.__hkNeighborPreload) return window.__hkNeighborPreload;
    if (!instance || !instance.Module) throw new Error('Hollow Knight Unity instance is unavailable');
    const module = instance.Module;
    const FS = module.__FS;
    const stats = window.__hkLazyStats;
    if (!FS || !stats || typeof module.__hkDataPartUrl !== 'function') {
      throw new Error('Matching r3 Hollow Knight filesystem is required');
    }
    const partSize = Number(options.partSize) || DEFAULT_PART_SIZE;
    const recentReadWindowMs = Math.max(250, Number(options.recentReadWindowMs) || DEFAULT_READ_WINDOW_MS);
    const dataPartUrls = options.dataPartUrls;
    if (!Array.isArray(dataPartUrls) || !dataPartUrls.length) throw new Error('Missing preload part URLs');
    const partCount = dataPartUrls.length;
    const state = {
      currentScene: '', currentSource: '', lastLevelTime: -Infinity,
      resourceToScene: new Map(), recentDataReads: [], candidateScene: '', candidateHits: 0,
      candidateTimer: null, warmController: null, warmedParts: new Map(),
      activeWarmParts: new Set(), failedParts: new Map(), learnedParts: new Map(),
      desiredParts: new Set(), queue: [], refreshTimer: null, running: false,
      suspended: Boolean(document.hidden), disposed: false, status: 'initializing',
      warmRequests: 0, warmRetries: 0, warmFailures: 0, warmBytes: 0,
      lastError: '', lastFailure: null, streamFallbacks: 0, markerRanges: 0,
      lastFileRestore: null, dataReadRestore: null
    };

    function reportError(error, detail) {
      const message = error && error.message ? error.message : String(error);
      state.lastFailure = Object.assign({ message }, detail);
      if (state.lastError !== message) console.warn('Hollow Knight preload:', message, detail);
      state.lastError = message;
    }

    // One retry loop covers headers, the ENTIRE body, and length/JSON validation.
    // Retrying the same URL with reload repairs the cache key LazyFS will use.
    async function fetchChecked(url, expected, signal) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const request = new AbortController();
        const abort = () => request.abort();
        if (signal) {
          if (signal.aborted) request.abort();
          signal.addEventListener('abort', abort, { once: true });
        }
        const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
        let response;
        let reader;
        try {
          if (attempt) state.warmRetries += 1;
          state.warmRequests += 1;
          response = await preloadFetch(url, {
            cache: attempt === 0 ? 'force-cache' : 'reload',
            credentials: 'same-origin', signal: request.signal
          });
          if (response.status !== 200) throw new Error('Preload HTTP ' + response.status + ' for ' + url);
          if (expected === null) return JSON.parse(await response.text());
          let bytes = 0;
          if (response.body && typeof response.body.getReader === 'function') {
            reader = response.body.getReader();
            while (true) {
              const item = await reader.read();
              if (item.done) break;
              bytes += item.value.byteLength;
              if (bytes > expected) throw new Error('Oversized preload part ' + url);
            }
          } else {
            // Retained compatibility path; exposed rather than silently hidden.
            state.streamFallbacks += 1;
            bytes = (await response.arrayBuffer()).byteLength;
          }
          if (bytes !== expected) throw new Error('Preload expected ' + expected + ' bytes, got ' + bytes + ' for ' + url);
          if (request.signal.aborted) throw new Error('Preload request interrupted');
          state.warmBytes += bytes;
          return;
        } catch (error) {
          if (reader) {
            try { await reader.cancel(); } catch (_) { /* Preserve the original failure. */ }
          } else if (response && response.body) {
            try { await response.body.cancel(); } catch (_) { /* Preserve the original failure. */ }
          }
          if ((signal && signal.aborted) || attempt === 2) throw error;
        } finally {
          if (reader) reader.releaseLock();
          clearTimeout(timeout);
          if (signal) signal.removeEventListener('abort', abort);
        }
      }
    }

    const map = await fetchChecked(options.mapUrl || 'build/preload-analysis/preload-map.analysis.json', null);
    if (!map || !map._meta || !map.scenes || typeof map.scenes !== 'object' ||
        map._meta.outerChunkSize !== partSize || map._meta.outerChunkCount !== partCount ||
        !Number.isSafeInteger(map._meta.logicalArchiveSize) ||
        Math.ceil(map._meta.logicalArchiveSize / partSize) !== partCount) {
      throw new Error('Hollow Knight preload map geometry is malformed or stale');
    }
    const ranges = buildSceneRanges(FS, map);
    state.markerRanges = ranges.length;
    const sceneParts = new Map();
    for (const [name, record] of Object.entries(map.scenes)) {
      if (record.resourceFile) state.resourceToScene.set(record.resourceFile.split('/').pop(), name);
      sceneParts.set(name, new Set(record.dataUnity3dChunks || []));
    }

    function getSceneRecord(name) { return map.scenes[name] || null; }

    function orderedNeighborParts(sceneName) {
      const record = getSceneRecord(sceneName);
      if (!record) return [];
      const neighbors = (record.neighbors || []).filter(name => getSceneRecord(name));
      const groups = neighbors.map(name => getSceneRecord(name).directPreloadChunks || []);
      const seen = new Set(), parts = [];
      // Round-robin direct chunks: a large alphabetically first neighbor must
      // not monopolize the only worker while every other exit remains cold.
      const depth = Math.max(0, ...groups.map(group => group.length));
      for (let index = 0; index < depth; index += 1) {
        for (const group of groups) {
          const part = group[index];
          if (Number.isInteger(part) && part >= 1 && part <= partCount && !seen.has(part)) {
            seen.add(part); parts.push(part);
          }
        }
      }
      let extras = 0;
      for (const name of neighbors) {
        for (const part of state.learnedParts.get(name) || []) {
          if (extras >= MAX_LEARNED_PARTS) break;
          if (!seen.has(part)) { seen.add(part); parts.push(part); extras += 1; }
        }
      }
      return parts;
    }

    function scheduleWarmPass() {
      if (state.refreshTimer !== null) clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
      if (state.disposed || state.suspended || state.running || !state.desiredParts.size) return;
      let next = Infinity;
      for (const part of state.desiredParts) {
        const failure = state.failedParts.get(part);
        const warmed = state.warmedParts.get(part);
        next = Math.min(next, failure || (warmed && warmed.url === module.__hkDataPartUrl(part - 1)
          ? warmed.time + WARM_TTL_MS : performance.now()));
      }
      state.refreshTimer = setTimeout(() => {
        state.refreshTimer = null;
        warmNeighbors();
      }, Math.max(1, next - performance.now()));
    }

    async function runWarmQueue() {
      if (state.running) return;
      state.running = true;
      try {
        while (!state.disposed && !state.suspended && state.queue.length) {
          const part = state.queue.shift();
          const url = module.__hkDataPartUrl(part - 1);
          const warmed = state.warmedParts.get(part);
          if (warmed && warmed.url === url && performance.now() - warmed.time < WARM_TTL_MS) continue;
          const request = new AbortController();
          state.warmController = request;
          state.activeWarmParts.add(part);
          state.status = 'warming';
          try {
            const expected = Math.min(partSize, map._meta.logicalArchiveSize - (part - 1) * partSize);
            await fetchChecked(url, expected, request.signal);
            if (!request.signal.aborted) {
              state.warmedParts.set(part, { url, time: performance.now() });
              state.failedParts.delete(part);
            }
          } catch (error) {
            if (!request.signal.aborted) {
              state.warmFailures += 1;
              state.failedParts.set(part, performance.now() + RETRY_COOLDOWN_MS);
              reportError(error, { part, url });
            }
          } finally {
            state.activeWarmParts.delete(part);
            state.warmController = null;
          }
        }
      } finally {
        state.running = false;
        state.status = state.disposed ? 'stopped' : state.suspended ? 'suspended' :
          !state.currentScene ? 'waiting-for-scene' :
          [...state.desiredParts].some(part => state.failedParts.has(part)) ? 'retrying' : 'ready';
        scheduleWarmPass();
      }
    }

    function warmNeighbors() {
      if (state.disposed || state.suspended) return;
      if (state.refreshTimer !== null) clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
      const parts = orderedNeighborParts(state.currentScene);
      state.desiredParts = new Set(parts);
      const now = performance.now();
      state.queue = parts.filter(part => {
        const warmed = state.warmedParts.get(part);
        return !state.activeWarmParts.has(part) && !(state.failedParts.get(part) > now) &&
          (!warmed || warmed.url !== module.__hkDataPartUrl(part - 1) || now - warmed.time >= WARM_TTL_MS);
      });
      for (const part of state.activeWarmParts) {
        if (!state.desiredParts.has(part) && state.warmController) state.warmController.abort();
      }
      // A single runner owns ALL requests, even while an aborted body settles.
      // Replacing the queue cannot spawn a second worker.
      if (state.queue.length) runWarmQueue().catch(error => reportError(error, { phase: 'queue' }));
      else scheduleWarmPass();
    }

    function learnParts(parts) {
      if (!state.currentScene || (state.currentSource !== 'level-block' && state.currentSource !== 'resource')) return;
      let learned = state.learnedParts.get(state.currentScene);
      if (!learned) { learned = new Set(); state.learnedParts.set(state.currentScene, learned); }
      const direct = getSceneRecord(state.currentScene).directPreloadChunks || [];
      for (const part of parts) {
        if (learned.size >= MAX_LEARNED_PARTS) break;
        if (!direct.includes(part)) learned.add(part);
      }
    }

    function setCurrentScene(sceneName, source) {
      if (!getSceneRecord(sceneName)) return false;
      if (source === 'level-block') state.lastLevelTime = performance.now();
      if (source === 'resource' && sceneName !== state.currentScene &&
          performance.now() - state.lastLevelTime < recentReadWindowMs) return false;
      const changed = state.currentScene !== sceneName;
      state.currentScene = sceneName;
      if (changed || source === 'level-block' || state.currentSource !== 'level-block') state.currentSource = source;
      if (changed) {
        state.candidateScene = ''; state.candidateHits = 0;
        // Recent completed reads include dependencies loaded before the level
        // marker. Learning is bounded, session-only, and never alters game data.
        for (const read of state.recentDataReads) {
          if (read.parts.length <= MAX_LEARNED_PARTS) learnParts(read.parts);
        }
        state.recentDataReads.length = 0;
        warmNeighbors();
      }
      return true;
    }

    function partsForDataRange(position, length) {
      if (!Number.isFinite(position) || !Number.isFinite(length) || length <= 0) return [];
      const start = map._meta.dataUnity3dOuterOffset + position;
      const end = start + length;
      const first = Math.floor(start / partSize) + 1;
      const last = Math.floor((end - 1) / partSize) + 1;
      const parts = [];
      for (let part = first; part <= last; part += 1) {
        if (part >= 1 && part <= partCount) parts.push(part);
      }
      return parts;
    }

    function inferNeighborScene() {
      const reads = state.recentDataReads;
      if (!reads.length) return;
      const current = getSceneRecord(state.currentScene);
      const candidates = current && current.neighbors && current.neighbors.length
        ? current.neighbors : [...sceneParts.keys()];
      const currentParts = sceneParts.get(state.currentScene) || new Set();
      const scored = [];
      for (const name of candidates) {
        if (name === state.currentScene) continue;
        const target = sceneParts.get(name);
        if (!target) continue;
        const evidence = new Set(), support = new Set();
        for (const read of reads) {
          if (read.parts.some(part => target.has(part) && !currentParts.has(part))) {
            // Count actual completed read ranges, not callbacks or timer ticks.
            support.add(read.position + ':' + read.length);
            for (const part of read.parts) if (target.has(part) && !currentParts.has(part)) evidence.add(part);
          }
        }
        if (evidence.size) scored.push({ scene: name, evidence: evidence.size, support: support.size });
      }
      scored.sort((a, b) => b.evidence - a.evidence || b.support - a.support);
      const best = scored[0], second = scored[1];
      if (!best || (second && best.evidence === second.evidence && best.support === second.support)) {
        state.candidateScene = ''; state.candidateHits = 0; return;
      }
      state.candidateScene = best.scene; state.candidateHits = best.support;
      if (best.support >= 2 || best.evidence >= 2) setCurrentScene(best.scene, 'data-read');
    }

    function recordDataRead(position, length, started) {
      const parts = partsForDataRange(position, length);
      if (!parts.length) return;
      const now = performance.now();
      const previous = state.recentDataReads[state.recentDataReads.length - 1];
      // A read blocked on network keeps its evidence. Gaps BETWEEN reads end a
      // burst; wall-clock time while a read is blocked cannot erase that read.
      if (previous && started - previous.time > recentReadWindowMs) state.recentDataReads.length = 0;
      if (state.recentDataReads.length === MAX_RECENT_READS) state.recentDataReads.shift();
      state.recentDataReads.push({ position, length, time: now, parts });
      // Locate exclusive level-file compressed spans rather than guessing
      // solely from 4 MiB chunk IDs (several rooms can share a physical chunk).
      let low = 0, high = ranges.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (ranges[middle].end <= position) low = middle + 1; else high = middle;
      }
      let scene = '';
      for (let index = low; index < ranges.length && ranges[index].start < position + length; index += 1) {
        if (scene && scene !== ranges[index].scene) { scene = ''; break; }
        scene = ranges[index].scene;
      }
      if (scene) setCurrentScene(scene, 'level-block');
      // Bulk bundle reads are not a useful dependency observation.
      if (parts.length <= MAX_LEARNED_PARTS) learnParts(parts);
      if (state.candidateTimer === null && !state.suspended) {
        // Throttle, not debounce: continuous reads cannot postpone this forever.
        state.candidateTimer = setTimeout(() => {
          state.candidateTimer = null;
          inferNeighborScene();
        }, 220);
      }
    }

    function installLastFileHook() {
      const descriptor = Object.getOwnPropertyDescriptor(stats, 'lastFile');
      if (descriptor && descriptor.configurable === false) throw new Error('Preload resource hook is not configurable');
      let currentValue = stats.lastFile || '';
      const inspect = value => {
        const scene = state.resourceToScene.get(String(value || '').split('/').pop());
        if (scene) setCurrentScene(scene, 'resource');
      };
      Object.defineProperty(stats, 'lastFile', {
        configurable: true, enumerable: true,
        get() { return currentValue; },
        set(value) {
          currentValue = value;
          try { inspect(value); } catch (error) { reportError(error, { phase: 'resource-detection' }); }
        }
      });
      state.lastFileRestore = () => {
        Object.defineProperty(stats, 'lastFile', descriptor && (descriptor.get || descriptor.set)
          ? descriptor : Object.assign({ configurable: true, enumerable: true, writable: true }, descriptor, { value: currentValue }));
      };
      inspect(currentValue);
    }

    function installDataReadHook() {
      const node = FS.lookupPath('data.unity3d').node;
      const ops = node.stream_ops;
      const originalRead = ops.read, originalMmap = ops.mmap;
      if (typeof originalRead !== 'function') throw new Error('Bundle read operation is unavailable');
      ops.read = function (stream, buffer, offset, length, position) {
        const started = performance.now();
        const count = originalRead.apply(this, arguments);
        try { recordDataRead(position, count, started); }
        catch (error) { reportError(error, { phase: 'read-detection' }); }
        return count;
      };
      if (typeof originalMmap === 'function') {
        ops.mmap = function (stream, buffer, address, length, position) {
          const started = performance.now();
          const result = originalMmap.apply(this, arguments);
          try { recordDataRead(position, Math.max(0, Math.min(length, node.usedBytes - position)), started); }
          catch (error) { reportError(error, { phase: 'mmap-detection' }); }
          return result;
        };
      }
      state.dataReadRestore = () => { ops.read = originalRead; if (originalMmap) ops.mmap = originalMmap; };
    }

    function suspend() {
      state.suspended = true; state.status = 'suspended'; state.queue.length = 0;
      if (state.refreshTimer !== null) clearTimeout(state.refreshTimer);
      if (state.candidateTimer !== null) clearTimeout(state.candidateTimer);
      state.refreshTimer = state.candidateTimer = null;
      if (state.warmController) state.warmController.abort();
    }

    function resume() {
      if (state.disposed || document.hidden || !state.suspended) return;
      state.suspended = false;
      state.recentDataReads.length = 0;
      state.candidateScene = ''; state.candidateHits = 0;
      state.warmedParts.clear(); state.failedParts.clear();
      warmNeighbors();
    }

    const visibility = () => document.hidden ? suspend() : resume();
    const online = () => { state.failedParts.clear(); warmNeighbors(); };
    const controller = {
      version: '1.2.0', build: BUILD_VERSION, state,
      cleanup() {
        state.disposed = true; suspend(); state.status = 'stopped';
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('pagehide', suspend);
        window.removeEventListener('pageshow', resume);
        window.removeEventListener('online', online);
        if (state.lastFileRestore) state.lastFileRestore();
        if (state.dataReadRestore) state.dataReadRestore();
        state.warmedParts.clear(); state.learnedParts.clear(); state.failedParts.clear();
        if (window.__hkNeighborPreload === controller) delete window.__hkNeighborPreload;
      }
    };
    try {
      installLastFileHook();
      installDataReadHook();
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('pagehide', suspend);
      window.addEventListener('pageshow', resume);
      window.addEventListener('online', online);
    } catch (error) {
      controller.cleanup();
      throw error;
    }
    window.__hkNeighborPreload = controller;
    state.status = state.suspended ? 'suspended' : state.running ? 'warming' :
      state.currentScene ? 'ready' : 'waiting-for-scene';
    return controller;
  };
})();
