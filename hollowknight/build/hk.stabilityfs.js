(function (global) {
  'use strict';

  const MAGIC = 'UnityWebData1.0\0';
  const HEADER_PREFIX_SIZE = MAGIC.length + 4;
  const CACHE_LIMIT = 60 * 1024 * 1024;
  const FS_VERSION = '2026.09.25-r2';
  // Captured before index.html installs its startup-only fetch wrapper, so
  // bootstrap has one bounded retry loop covering headers AND body reads.
  const dataFetch = global.fetch.bind(global);
  let retrySerial = 0;
  global.__hkStabilityFSVersion = FS_VERSION;

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function setMessage(text) {
    const element = document.getElementById('message');
    if (element) element.textContent = text;
  }

  function readString(bytes, offset, length) {
    let value = '';
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(bytes[offset + index]);
    }
    return value;
  }

  function validateMagic(bytes) {
    if (
      bytes.byteLength < HEADER_PREFIX_SIZE ||
      readString(bytes, 0, MAGIC.length) !== MAGIC
    ) {
      throw new Error('StabilityFS: unexpected UnityWebData archive header');
    }
  }

  function parseArchive(header, totalSize) {
    validateMagic(header);

    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength
    );
    const headerEnd = view.getUint32(MAGIC.length, true);

    if (
      headerEnd < HEADER_PREFIX_SIZE ||
      headerEnd > totalSize ||
      headerEnd > header.byteLength
    ) {
      throw new Error('StabilityFS: invalid archive header length');
    }

    const entries = [];
    let position = HEADER_PREFIX_SIZE;

    while (position < headerEnd) {
      if (position + 12 > headerEnd) {
        throw new Error('StabilityFS: truncated archive record');
      }

      const offset = view.getUint32(position, true);
      position += 4;
      const size = view.getUint32(position, true);
      position += 4;
      const nameLength = view.getUint32(position, true);
      position += 4;

      if (nameLength > headerEnd - position) {
        throw new Error('StabilityFS: truncated archive filename');
      }

      const name = readString(header, position, nameLength);
      position += nameLength;

      if (offset > totalSize || size > totalSize - offset) {
        throw new Error('StabilityFS: archive entry outside data file');
      }

      entries.push({ offset, size, name });
    }

    if (position !== headerEnd) {
      throw new Error('StabilityFS: malformed archive header');
    }

    return entries;
  }

  function createDirectories(module, fileName) {
    for (
      let start = 0, slash = fileName.indexOf('/', start) + 1;
      slash > 0;
      start = slash, slash = fileName.indexOf('/', start) + 1
    ) {
      module.FS_createPath(
        fileName.substring(0, start),
        fileName.substring(start, slash - 1),
        true,
        true
      );
    }
  }

  function requestUrl(url, attempt, fallbackUrl) {
    if (attempt === 0) return url; // Preserve the normal preloader/cache key.
    const result = new URL(
      attempt === 2 && fallbackUrl ? fallbackUrl : url,
      document.baseURI
    );
    // Query-only retry: no custom headers (and no CORS preflight).
    result.searchParams.set(
      'hk_read_retry', Date.now().toString(36) + '-' + (++retrySerial)
    );
    return result.href;
  }

  function dataFailure(message, detail) {
    const error = new Error(message);
    error.name = 'HollowKnightDataError';
    error.hkDataIO = true;
    error.detail = detail;
    return error;
  }

  function checkResponse(status, actual, expected, url, attempt) {
    const detail = { url, attempt: attempt + 1, status, expected, actual };
    // A cached success is delivered as HTTP 200. Bare 304, status 0, 204,
    // partial 206, and wrong-sized bodies are not valid whole-file responses.
    if (status !== 200) {
      throw dataFailure('StabilityFS HTTP ' + status + ' for ' + url, detail);
    }
    if (actual !== expected) {
      throw dataFailure(
        'StabilityFS: expected ' + expected + ' bytes, got ' + actual +
        ' for ' + url, detail
      );
    }
  }

  function rememberAttempt(stats, error, detail) {
    const failure = Object.assign({}, detail, { message: errorText(error) });
    stats.lastTransportFailure = failure; // One bounded record, not a log.
    if (detail.actual !== null && detail.actual !== detail.expected) {
      stats.lengthFailures += 1;
    }
    return failure;
  }

  async function fetchBytes(url, expected, stats, fallbackUrl, validate) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const targetUrl = requestUrl(url, attempt, fallbackUrl);
      const detail = {
        url: targetUrl, attempt: attempt + 1,
        status: 0, expected, actual: null
      };
      if (attempt > 0) {
        stats.bootstrapRetries += 1;
        setMessage('Retrying archive index (' + (attempt + 1) + '/3)…');
        await new Promise(resolve => global.setTimeout(resolve, attempt * 600));
      }
      let response;
      try {
        response = await dataFetch(targetUrl, {
          cache: attempt === 0 ? 'force-cache' : 'reload'
        });
        detail.status = response.status;
        if (response.status !== 200) {
          checkResponse(response.status, null, expected, targetUrl, attempt);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        detail.actual = bytes.byteLength;
        checkResponse(response.status, bytes.byteLength, expected, targetUrl, attempt);
        if (validate) validate(bytes);
        if (attempt > 0) stats.bootstrapRecovered += 1;
        if (attempt === 2 && fallbackUrl) stats.fallbackLoads += 1;
        return { bytes, url: targetUrl };
      } catch (error) {
        lastError = dataFailure(
          'StabilityFS bootstrap failed: ' + errorText(error),
          rememberAttempt(stats, error, detail)
        );
        try {
          if (response && response.body) await response.body.cancel();
        } catch (_) {}
      }
    }
    stats.lastError = lastError.message;
    throw lastError;
  }

  function syncWhole(url, expected, stats, fallbackUrl) {
    const started = performance.now();
    const partName = url.split('?')[0].split('/').pop() || url;
    let lastError;
    stats.activePart = partName;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const targetUrl = requestUrl(url, attempt, fallbackUrl);
        const detail = {
          url: targetUrl, attempt: attempt + 1,
          status: 0, expected, actual: null
        };
        stats.phase = attempt ? 'sync-retry' : 'sync-read';
        if (attempt) stats.syncRetries += 1;
        setMessage(attempt
          ? 'Connection interrupted — retrying ' + partName +
            ' (' + (attempt + 1) + '/3)…'
          : 'Streaming ' + partName + '…');
        let xhr = null;
        let text = '';
        try {
          xhr = new XMLHttpRequest();
          xhr.open('GET', targetUrl, false);
          // Do not set responseType=arraybuffer or timeout on a synchronous
          // main-thread XHR. Keep the established Safari binary-text path.
          xhr.overrideMimeType('text/plain; charset=x-user-defined');
          xhr.send(null);
          detail.status = xhr.status;
          if (xhr.status !== 200) {
            checkResponse(xhr.status, null, expected, targetUrl, attempt);
          }
          text = xhr.responseText || '';
          detail.actual = text.length;
          checkResponse(xhr.status, text.length, expected, targetUrl, attempt);
        } catch (error) {
          stats.syncAttemptFailures += 1;
          lastError = dataFailure(
            'StabilityFS data request failed: ' + errorText(error),
            rememberAttempt(stats, error, detail)
          );
          continue;
        } finally {
          xhr = null;
        }

        // Allocate only after exact length validation. Allocation failures
        // must not trigger three repeated downloads/allocation attempts.
        let bytes;
        try {
          bytes = new Uint8Array(expected);
        } catch (error) {
          const failure = new Error('StabilityFS: chunk allocation failed: ' + errorText(error));
          failure.hkAllocationFailure = true;
          throw failure;
        }
        for (let index = 0; index < expected; index += 1) {
          bytes[index] = text.charCodeAt(index) & 255;
        }
        text = '';
        stats.syncPartLoads += 1;
        stats.syncBytes += bytes.byteLength;
        if (attempt) stats.syncRecovered += 1;
        if (attempt === 2 && fallbackUrl) stats.fallbackLoads += 1;
        return { bytes, url: targetUrl };
      }
      throw lastError;
    } finally {
      stats.syncBlockedMs += performance.now() - started;
      stats.activePart = '';
    }
  }

  async function mountUnityDataParts(module, urls, options) {
    if (
      !module ||
      !module.__FS ||
      typeof module.FS_createDataFile !== 'function'
    ) {
      throw new Error('StabilityFS: patched Emscripten FS was not exported');
    }

    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error('StabilityFS: no data part URLs');
    }

    const settings = options || {};
    const partSize = Number(settings.partSize);
    const totalSize = Number(settings.totalSize);
    const onProgress =
      typeof settings.onProgress === 'function' ? settings.onProgress : null;

    if (!Number.isSafeInteger(partSize) || partSize <= 0) {
      throw new Error('StabilityFS: invalid physical part size');
    }
    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
      throw new Error('StabilityFS: invalid logical archive size');
    }

    const expectedParts = Math.ceil(totalSize / partSize);
    if (urls.length !== expectedParts) {
      throw new Error(
        'StabilityFS: expected ' + expectedParts +
        ' physical parts, got ' + urls.length
      );
    }

    const finalPartSize = totalSize - partSize * (urls.length - 1);
    if (finalPartSize <= 0 || finalPartSize > partSize) {
      throw new Error('StabilityFS: invalid final part geometry');
    }

    const partLengths = new Array(urls.length).fill(partSize);
    partLengths[partLengths.length - 1] = finalPartSize;

    const FS = module.__FS;
    const fallbackUrls = settings.fallbackUrls || [];
    if (!Array.isArray(fallbackUrls) ||
        (fallbackUrls.length !== 0 && fallbackUrls.length !== urls.length)) {
      throw new Error('StabilityFS: fallback list must match the data parts');
    }
    // Remember only URL strings after recovery, not additional data buffers.
    // An evicted recovered part must not revisit a known-bad cached URL.
    const preferredUrls = urls.slice();
    const cache = new Map();
    const demandedParts = new Set();
    const touchedFiles = new Set();
    let residentBytes = 0;

    const stats = global.__hkLazyStats = {
      version: FS_VERSION,
      phase: 'bootstrap',
      transport: 'whole-file',
      totalFiles: 0,
      loadedFiles: 0,
      chunkSize: partSize,
      archiveBytes: totalSize,
      cacheBytes: 0,
      cacheLimit: CACHE_LIMIT,
      cacheItems: 0,
      cachePeakBytes: 0,
      cachePeakItems: 0,
      cacheHits: 0,
      cacheMisses: 0,
      uniqueParts: 0,
      refetches: 0,
      evictions: 0,
      syncPartLoads: 0,
      syncRetries: 0,
      syncAttemptFailures: 0,
      syncRecovered: 0,
      bootstrapRetries: 0,
      bootstrapRecovered: 0,
      lengthFailures: 0,
      fallbackLoads: 0,
      ioFailures: 0,
      lastTransportFailure: null,
      lastFailure: null,
      syncBytes: 0,
      syncBlockedMs: 0,
      opens: 0,
      closes: 0,
      readCalls: 0,
      readBytes: 0,
      mmapCalls: 0,
      mmapBytes: 0,
      activeFile: '',
      activePart: '',
      lastFile: '',
      lastError: ''
    };

    function refreshCacheStats() {
      stats.cacheBytes = residentBytes;
      stats.cacheItems = cache.size;
      stats.cachePeakBytes = Math.max(stats.cachePeakBytes, residentBytes);
      stats.cachePeakItems = Math.max(stats.cachePeakItems, cache.size);
    }

    function touchPart(partIndex, record) {
      cache.delete(partIndex);
      cache.set(partIndex, record);
      return record.bytes;
    }

    function evictFor(bytesNeeded) {
      if (bytesNeeded > CACHE_LIMIT) {
        throw new Error('StabilityFS: one physical part exceeds cache limit');
      }

      // Evict before the XHR/allocation. This keeps the resident source cache
      // below its 60 MiB ceiling even during a new-part fetch.
      while (residentBytes + bytesNeeded > CACHE_LIMIT && cache.size > 0) {
        const victim = cache.keys().next().value;
        const record = cache.get(victim);
        cache.delete(victim);
        residentBytes -= record.bytes.byteLength;
        stats.evictions += 1;
      }

      refreshCacheStats();
    }

    function storePart(partIndex, bytes) {
      const expected = partLengths[partIndex];
      if (bytes.byteLength !== expected) {
        throw new Error(
          'StabilityFS: part ' + (partIndex + 1) +
          ' expected ' + expected + ' bytes, got ' + bytes.byteLength
        );
      }

      const existing = cache.get(partIndex);
      if (existing) {
        return touchPart(partIndex, existing);
      }

      evictFor(bytes.byteLength);
      const record = { bytes };
      cache.set(partIndex, record);
      residentBytes += bytes.byteLength;
      refreshCacheStats();
      return bytes;
    }

    async function bootstrapPart(partIndex) {
      const cached = cache.get(partIndex);
      if (cached) return touchPart(partIndex, cached);

      evictFor(partLengths[partIndex]);
      const result = await fetchBytes(
        preferredUrls[partIndex], partLengths[partIndex], stats,
        fallbackUrls[partIndex], partIndex === 0 ? bytes => {
          validateMagic(bytes);
          const headerEnd = new DataView(
            bytes.buffer, bytes.byteOffset, bytes.byteLength
          ).getUint32(MAGIC.length, true);
          if (headerEnd < HEADER_PREFIX_SIZE || headerEnd > totalSize) {
            throw new Error('StabilityFS: invalid header extent');
          }
          if (headerEnd <= bytes.byteLength) parseArchive(bytes, totalSize);
        } : null
      );
      preferredUrls[partIndex] = result.url;
      return storePart(partIndex, result.bytes);
    }

    async function readArchiveHeader(firstPart) {
      validateMagic(firstPart);

      const headerEnd = new DataView(
        firstPart.buffer,
        firstPart.byteOffset,
        firstPart.byteLength
      ).getUint32(MAGIC.length, true);

      if (headerEnd < HEADER_PREFIX_SIZE || headerEnd > totalSize) {
        throw new Error('StabilityFS: invalid header extent');
      }

      if (headerEnd <= firstPart.byteLength) {
        return firstPart.subarray(0, headerEnd);
      }

      const header = new Uint8Array(headerEnd);
      let copied = 0;
      let partIndex = 0;

      while (copied < headerEnd) {
        if (partIndex >= urls.length) {
          throw new Error('StabilityFS: archive header exceeds data parts');
        }

        const part = await bootstrapPart(partIndex);
        const count = Math.min(part.byteLength, headerEnd - copied);
        header.set(part.subarray(0, count), copied);
        copied += count;
        partIndex += 1;
      }

      return header;
    }

    function markTouched(entry) {
      if (!touchedFiles.has(entry.name)) {
        touchedFiles.add(entry.name);
        stats.loadedFiles = touchedFiles.size;
      }
      stats.lastFile = entry.name;
    }

    function getPart(partIndex) {
      if (partIndex < 0 || partIndex >= urls.length) {
        throw new Error('StabilityFS: data read outside physical part list');
      }

      const cached = cache.get(partIndex);
      if (cached) {
        stats.cacheHits += 1;
        return touchPart(partIndex, cached);
      }

      stats.cacheMisses += 1;
      if (demandedParts.has(partIndex)) {
        stats.refetches += 1;
      } else {
        demandedParts.add(partIndex);
        stats.uniqueParts = demandedParts.size;
      }

      const expected = partLengths[partIndex];
      evictFor(expected);

      let bytes;
      try {
        const result = syncWhole(
          preferredUrls[partIndex], expected, stats, fallbackUrls[partIndex]
        );
        preferredUrls[partIndex] = result.url;
        bytes = result.bytes;
      } catch (error) {
        stats.lastError = errorText(error);
        throw error;
      }

      return storePart(partIndex, bytes);
    }

    function reportReadFailure(error, entry, operation, position, length) {
      const previous = stats.lastFailure;
      const detail = Object.assign({}, error && error.detail, {
        kind: error && error.hkDataIO ? 'data-io' :
          error && error.hkAllocationFailure ? 'allocation' : 'filesystem',
        file: entry.name, operation, position, length,
        message: errorText(error),
        heapBytes: module.HEAPU8 ? module.HEAPU8.byteLength : null
      });
      stats.lastError = detail.message;
      stats.lastFailure = detail;
      global.__hkLastReadFailure = detail;
      if (error && error.hkDataIO) stats.ioFailures += 1;
      // Diagnostic hooks must never introduce another filesystem exception.
      if (!previous || previous.message !== detail.message ||
          previous.file !== detail.file || previous.position !== position) {
        try { console.error('Hollow Knight data read failed:', detail); } catch (_) {}
        try {
          if (typeof settings.onReadError === 'function') settings.onReadError(detail);
        } catch (_) {}
      }
      // Use this build's Linux errno values, not modern WASI's numbering.
      // This is a failed read, NEVER fake EOF, zero-fill or a successful count.
      if (error instanceof FS.ErrnoError) return error;
      if (error && (error.hkDataIO || error.hkAllocationFailure)) {
        const fsError = new FS.ErrnoError(error.hkDataIO ? 5 : 12);
        fsError.message = detail.message;
        return fsError;
      }
      // Preserve unexpected programming failures, with a serializable message
      // so the old framework's JSON.stringify(error) no longer erases it.
      try {
        Object.defineProperty(error, 'message', {
          value: detail.message, enumerable: true, configurable: true
        });
      } catch (_) {}
      return error;
    }

    function readInto(entry, filePosition, length, target, targetOffset) {
      if (!Number.isSafeInteger(filePosition) || filePosition < 0 ||
          !Number.isSafeInteger(length) || length < 0 ||
          !Number.isSafeInteger(targetOffset) || targetOffset < 0) {
        throw new FS.ErrnoError(22);
      }
      if (length === 0 || filePosition >= entry.size) return 0;

      let remaining = Math.min(length, entry.size - filePosition);
      if (!target || typeof target.set !== 'function' ||
          target.BYTES_PER_ELEMENT !== 1 ||
          targetOffset > target.length || remaining > target.length - targetOffset) {
        throw new FS.ErrnoError(14);
      }
      let archiveOffset = entry.offset + filePosition;
      let destination = targetOffset;

      while (remaining > 0) {
        const partIndex = Math.floor(archiveOffset / partSize);
        const offsetInPart = archiveOffset - partIndex * partSize;
        const part = getPart(partIndex);

        if (offsetInPart < 0 || offsetInPart >= part.byteLength) {
          throw new Error(
            'StabilityFS: file points outside part ' + (partIndex + 1)
          );
        }

        const count = Math.min(remaining, part.byteLength - offsetInPart);
        if (count <= 0) {
          throw new Error('StabilityFS: invalid zero-length data read');
        }

        target.set(
          part.subarray(offsetInPart, offsetInPart + count),
          destination
        );

        archiveOffset += count;
        destination += count;
        remaining -= count;
      }

      const read = destination - targetOffset;
      markTouched(entry);
      return read;
    }

    stats.phase = 'bootstrap';
    setMessage('Reading Hollow Knight archive index…');

    const firstPart = await bootstrapPart(0);
    const header = await readArchiveHeader(firstPart);
    const entries = parseArchive(header, totalSize);
    stats.totalFiles = entries.length;

    stats.phase = 'mounting';
    setMessage('Registering virtual game files…');

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      createDirectories(module, entry.name);

      module.FS_createDataFile(
        entry.name,
        null,
        new Uint8Array(0),
        true,
        true,
        true
      );

      const node = FS.lookupPath(entry.name).node;
      node.usedBytes = entry.size;
      node.contents = null;

      const baseOps = node.stream_ops;
      const operations = Object.assign({}, baseOps, {
        open() {
          stats.opens += 1;
          markTouched(entry);
        },

        close() {
          stats.closes += 1;
        },

        read(stream, buffer, offset, length, position) {
          stats.activeFile = entry.name;
          stats.phase = 'read';
          stats.readCalls += 1;

          try {
            const count = readInto(
              entry,
              position,
              length,
              buffer,
              offset
            );
            stats.readBytes += count;
            return count;
          } catch (error) {
            throw reportReadFailure(error, entry, 'read', position, length);
          } finally {
            stats.activeFile = '';
          }
        },

        mmap(stream, buffer, address, length, position) {
          stats.activeFile = entry.name;
          stats.phase = 'mmap';
          stats.mmapCalls += 1;
          let pointer = 0;
          try {
            if (!Number.isSafeInteger(length) || length <= 0 ||
                !Number.isSafeInteger(position) || position < 0) {
              throw new FS.ErrnoError(22);
            }
            pointer = module._malloc(length);
            if (!pointer) {
              const failure = new FS.ErrnoError(12);
              failure.message = 'StabilityFS: WASM malloc failed while mapping ' + entry.name;
              throw failure;
            }
            // _malloc can grow WASM memory and detach the caller's old view.
            // Always acquire the current heap AFTER allocation.
            const heap = module.HEAPU8;
            if (!heap || pointer > heap.length || length > heap.length - pointer) {
              throw new FS.ErrnoError(14);
            }
            const count = readInto(entry, position, length, heap, pointer);
            // Zero only the legitimate mmap tail beyond the file's EOF.
            // A transport failure throws before reaching this statement.
            if (count < length) heap.fill(0, pointer + count, pointer + length);
            stats.mmapBytes += length;
            return { ptr: pointer, allocated: true };
          } catch (error) {
            if (pointer) module._free(pointer);
            throw reportReadFailure(error, entry, 'mmap', position, length);
          } finally {
            stats.activeFile = '';
          }
        },

        write() {
          stats.lastError =
            'StabilityFS: unexpected write to read-only asset ' + entry.name;
          throw new FS.ErrnoError(30);
        }
      });

      node.stream_ops = operations;

      if (onProgress && (index % 20 === 0 || index + 1 === entries.length)) {
        onProgress({
          phase: 'mounting',
          filesMounted: index + 1,
          totalFiles: entries.length
        });
      }
    }

    stats.phase = 'ready';
    refreshCacheStats();

    if (onProgress) {
      onProgress({
        phase: 'complete',
        filesMounted: entries.length,
        totalFiles: entries.length
      });
    }

    setMessage('Starting game…');
  }

  // Preserve the current save-flush behavior. This keeps IDBFS persistence
  // independent from the read-only game-data cache.
  function installHollowKnightPersistence(module) {
    if (!module || module.__hkPersistenceInstalled) {
      return Boolean(module && module.__hkPersistenceInstalled);
    }

    const FS = module.__FS;
    if (!FS || !FS.trackingDelegate || typeof FS.syncfs !== 'function') {
      return false;
    }

    const view = module.canvas && module.canvas.ownerDocument
      ? module.canvas.ownerDocument.defaultView
      : global;
    const documentRef = view && view.document;
    const previousWrite = FS.trackingDelegate.onWriteToFile;
    const previousMove = FS.trackingDelegate.onMovePath;
    const previousDelete = FS.trackingDelegate.onDeletePath;
    const isPersistentPath = path =>
      typeof path === 'string' &&
      (path === '/idbfs' || path.indexOf('/idbfs/') === 0);

    let dirty = false;
    let inFlight = false;
    let queued = false;
    let timer = null;

    const schedule = delay => {
      if (timer) view.clearTimeout(timer);
      timer = view.setTimeout(runSync, delay);
    };

    const runSync = () => {
      timer = null;
      if (!dirty) return;

      if (inFlight) {
        queued = true;
        return;
      }

      inFlight = true;
      queued = false;
      dirty = false;

      try {
        FS.syncfs(false, error => {
          inFlight = false;
          if (error) dirty = true;
          if (queued || dirty) schedule(error ? 2000 : 200);
        });
      } catch (_) {
        inFlight = false;
        dirty = true;
        schedule(2000);
      }
    };

    const markDirty = path => {
      if (!isPersistentPath(path)) return;
      dirty = true;
      schedule(350);
    };

    FS.trackingDelegate.onWriteToFile = function (path) {
      try {
        if (typeof previousWrite === 'function') {
          previousWrite.apply(this, arguments);
        }
      } catch (_) {}
      markDirty(path);
    };

    FS.trackingDelegate.onMovePath = function (oldPath, newPath) {
      try {
        if (typeof previousMove === 'function') {
          previousMove.apply(this, arguments);
        }
      } catch (_) {}
      markDirty(oldPath);
      markDirty(newPath);
    };

    FS.trackingDelegate.onDeletePath = function (path) {
      try {
        if (typeof previousDelete === 'function') {
          previousDelete.apply(this, arguments);
        }
      } catch (_) {}
      markDirty(path);
    };

    view.setInterval(() => {
      if (dirty && !inFlight && !timer) schedule(0);
    }, 2000);

    const flush = () => {
      if (dirty && !inFlight) {
        try { FS.syncfs(false, () => {}); } catch (_) {}
      }
    };

    view.addEventListener('pagehide', flush);
    if (documentRef) {
      documentRef.addEventListener('visibilitychange', () => {
        if (documentRef.hidden) flush();
      });
    }

    module.__hkPersistenceInstalled = true;
    return true;
  }

  // Preserve the current cross-iframe keyboard focus/forwarding behavior.
  function installHollowKnightKeyboardBridge(canvas) {
    if (!canvas || canvas.__hkKeyboardBridgeInstalled) {
      return Boolean(canvas && canvas.__hkKeyboardBridgeInstalled);
    }

    const gameDocument = canvas.ownerDocument;
    const gameWindow = gameDocument && gameDocument.defaultView;
    if (!gameWindow) return false;

    canvas.tabIndex = 0;

    const focusCanvas = () => {
      try { gameWindow.focus(); } catch (_) {}
      try {
        canvas.focus({ preventScroll: true });
      } catch (_) {
        try { canvas.focus(); } catch (_) {}
      }
    };

    const cloneKeyboardEvent = event => {
      try {
        return new gameWindow.KeyboardEvent(event.type, {
          key: event.key,
          code: event.code,
          location: event.location,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          bubbles: true,
          cancelable: true
        });
      } catch (_) {
        const forwarded = gameDocument.createEvent('Event');
        forwarded.initEvent(event.type, true, true);
        try {
          Object.defineProperties(forwarded, {
            key: { value: event.key },
            code: { value: event.code },
            keyCode: { value: event.keyCode },
            which: { value: event.which },
            ctrlKey: { value: event.ctrlKey },
            shiftKey: { value: event.shiftKey },
            altKey: { value: event.altKey },
            metaKey: { value: event.metaKey },
            repeat: { value: event.repeat }
          });
        } catch (_) {}
        return forwarded;
      }
    };

    const forwardKeyboard = event => {
      if (
        event.view === gameWindow ||
        (event.target && event.target.ownerDocument === gameDocument)
      ) {
        return;
      }

      try {
        gameDocument.dispatchEvent(cloneKeyboardEvent(event));
        focusCanvas();

        if (!(event.metaKey || event.ctrlKey || event.altKey)) {
          event.preventDefault();
          event.stopPropagation();
        }
      } catch (_) {}
    };

    const ancestorDocuments = [];
    let currentWindow = gameWindow;

    while (true) {
      try {
        const parentWindow = currentWindow.parent;
        if (!parentWindow || parentWindow === currentWindow) break;
        ancestorDocuments.push(parentWindow.document);
        currentWindow = parentWindow;
      } catch (_) {
        break;
      }
    }

    for (const documentRef of ancestorDocuments) {
      documentRef.addEventListener('keydown', forwardKeyboard, true);
      documentRef.addEventListener('keyup', forwardKeyboard, true);
      documentRef.addEventListener('visibilitychange', () => {
        if (!documentRef.hidden) gameWindow.setTimeout(focusCanvas, 0);
      });
    }

    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
      gameDocument.addEventListener(
        type,
        focusCanvas,
        type === 'touchstart'
          ? { capture: true, passive: true }
          : true
      );
    }

    gameDocument.addEventListener('visibilitychange', () => {
      if (!gameDocument.hidden) gameWindow.setTimeout(focusCanvas, 0);
    });
    gameWindow.addEventListener(
      'focus',
      () => gameWindow.setTimeout(focusCanvas, 0),
      true
    );

    canvas.__hkKeyboardBridgeInstalled = true;
    focusCanvas();
    return true;
  }

  global.mountUnityDataParts = mountUnityDataParts;
  global.installHollowKnightPersistence = installHollowKnightPersistence;
  global.installHollowKnightKeyboardBridge = installHollowKnightKeyboardBridge;
})(window);
