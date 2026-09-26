(function (global) {
  'use strict';

  const MAGIC = 'UnityWebData1.0\0';
  const HEADER_PREFIX_SIZE = MAGIC.length + 4;
  const CACHE_LIMIT = 60 * 1024 * 1024;
  const FS_VERSION = '2026.09.25-r4';
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
    // The preloader must warm the same URL as synchronous reads, including
    // remembered recovery URLs. Expose strings, never cache data/buffers.
    module.__hkDataPartUrl = partIndex => preferredUrls[partIndex];
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
      // visibilitychange and pagehide often arrive together. Use the same
      // serialized dirty/inFlight path as ordinary saves, not a second sync.
      if (timer) view.clearTimeout(timer);
      timer = null;
      runSync();
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

// r4: coordinate the surviving Unity instance across browser suspension.
// This does not recreate a lost GPU context or revive an OS-terminated page.
(function (global) {
  'use strict';
  const VERSION = '2026.09.25-r4';
  const AUDIO_WAIT_MS = 5000;

  // Insert a narrow bridge inside the EXISTING framework closure. The on-disk
  // framework and the WASM remain unchanged. Reject a different glue layout;
  // never silently launch with missing lifecycle hooks.
  global.prepareHollowKnightFramework = function (source) {
    const entry = 'function unityFramework(Module) {';
    const tick = '"suspended"===WEBAudio.audioContext.state?WEBAudio.audioContext.resume():Module.clearInterval(e)';
    const resume = 'function _JS_Sound_ResumeIfNeeded(){0!=WEBAudio.audioWebEnabled&&"suspended"===WEBAudio.audioContext.state&&WEBAudio.audioContext.resume()}';
    const ended = 'this.source.onended=function(){e&&dynCall("vi",e,[i]),o.setup()}';
    for (const marker of [entry, tick, resume, ended]) {
      if (source.indexOf(marker) === -1 || source.indexOf(marker) !== source.lastIndexOf(marker)) {
        throw new Error('Unexpected Unity framework layout; suspend/resume hooks were not applied.');
      }
    }
    const bridge = '\nModule.__hkRuntime = {' +
      'version:"' + VERSION + '",' +
      'get loop(){return Browser.mainLoop;},' +
      'get audio(){return WEBAudio.audioWebEnabled ? WEBAudio.audioContext : null;},' +
      'get aborted(){return Boolean(ABORT);},' +
      'get callbacksAllowed(){return Browser.allowAsyncCallbacks;},' +
      'get contextRestoreRegistered(){' +
        'for(var i=0;i<JSEvents.eventHandlers.length;i++){' +
          'var h=JSEvents.eventHandlers[i];' +
          'if(h.target===Module.canvas && h.eventTypeString==="webglcontextrestored" && h.callbackfunc)return true;' +
        '}return false;' +
      '},' +
      'pauseCallbacks:function(){Browser.pauseAsyncCallbacks();},' +
      'resumeCallbacks:function(){' +
        'Browser.allowAsyncCallbacks=true;' +
        'var q=Browser.queuedAsyncCallbacks,i=0;Browser.queuedAsyncCallbacks=[];' +
        'try{while(i<q.length && Browser.allowAsyncCallbacks && !Module.__hkLifecycle.state.paused && !ABORT){q[i++]();}}' +
        'finally{if(i<q.length)Browser.queuedAsyncCallbacks=q.slice(i).concat(Browser.queuedAsyncCallbacks);}' +
      '},' +
      'audioEnded:function(fn){' +
        'if(Module.__hkLifecycle.state.paused || !Browser.allowAsyncCallbacks)Browser.queuedAsyncCallbacks.push(fn);else fn();' +
      '}' +
      '};\n';
    return source.replace(entry, entry + bridge)
      .replace(tick, 'Module.__hkLifecycle.audioTick(e)')
      .replace(resume, 'function _JS_Sound_ResumeIfNeeded(){Module.__hkLifecycle.requestAudioResume()}')
      .replace(ended, 'this.source.onended=function(){Module.__hkRuntime.audioEnded(function(){e&&dynCall("vi",e,[i]),o.setup()})}');
  };

  global.installHollowKnightLifecycle = function (canvas) {
    if (global.__hkLifecycle) return global.__hkLifecycle;
    const doc = canvas.ownerDocument;
    const view = doc.defaultView;
    const documents = [doc];
    const views = [view];
    // The launcher uses same-origin srcdoc + Blob frames. Parent pagehide may
    // arrive before child visibilitychange; observe each accessible ancestor.
    for (let current = view; current.parent && current.parent !== current;) {
      try {
        const parent = current.parent;
        documents.push(parent.document);
        views.push(parent);
        current = parent;
      } catch (_) { break; } // Cross-origin ancestor: child visibility still applies.
    }
    const hiddenViews = new Set();
    const frozenDocuments = new Set();
    const state = {
      version: VERSION, phase: 'starting', paused: false, ready: false,
      reason: '', fatal: '', graphicsPending: false, audioState: 'uninitialized', lastError: '',
      suspends: 0, resumes: 0, events: [], storageError: '', previous: null
    };
    let module = null, runtime = null, audio = null;
    let ownLoopPause = false, ownCallbacksPause = false;
    let epoch = 0, disposed = false, pendingAudio = null;
    let panel = null, title = null, text = null, button = null, details = null;
    const storageKey = 'hk.lifecycle.last';
    try { state.previous = JSON.parse(view.sessionStorage.getItem(storageKey) || 'null'); }
    catch (error) { state.storageError = String(error.message || error); }

    function hidden() {
      if (hiddenViews.size > 0 || frozenDocuments.size > 0) return true;
      for (let index = 0; index < documents.length; index += 1) {
        if (documents[index].hidden) return true;
      }
      return false;
    }

    function report() {
      const stats = global.__hkLazyStats;
      return {
        version: VERSION, phase: state.phase, reason: state.reason, fatal: state.fatal,
        hidden: hidden(), graphicsPending: state.graphicsPending, audioState: audio ? audio.state : state.audioState,
        lastError: state.lastError, storageError: state.storageError,
        heapBytes: module && module.HEAPU8 ? module.HEAPU8.byteLength : 0,
        contextLost: Boolean(module && module.ctx && module.ctx.isContextLost()),
        fsError: stats ? stats.lastError : '',
        fsSyncLoads: stats ? stats.syncPartLoads : 0,
        fsSyncBlockedMs: stats ? stats.syncBlockedMs : 0,
        events: state.events.slice()
      };
    }

    function record(event) {
      state.events.push({ event, at: Math.round(view.performance.now()) });
      if (state.events.length > 24) state.events.shift();
      try { view.sessionStorage.setItem(storageKey, JSON.stringify(report())); }
      catch (error) { state.storageError = String(error.message || error); }
    }

    function show() {
      if (!state.paused || hidden() || disposed) return;
      if (!panel) {
        panel = doc.createElement('div');
        panel.id = 'hk-resume-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'hk-resume-title');
        panel.style.cssText = 'position:fixed;inset:0;z-index:2147483645;display:grid;' +
          'place-content:center;background:rgba(16,16,24,.94);color:#fff;' +
          'padding:24px;box-sizing:border-box;font:16px/1.5 system-ui,sans-serif;text-align:center';
        const box = doc.createElement('div');
        box.style.cssText = 'max-width:480px;width:100%';
        title = doc.createElement('h2'); title.id = 'hk-resume-title';
        title.style.cssText = 'font-size:22px;margin:0 0 12px';
        text = doc.createElement('p'); text.id = 'hk-resume-message';
        button = doc.createElement('button'); button.id = 'hk-resume-button'; button.type = 'button';
        button.style.cssText = 'font:600 16px system-ui;padding:12px 28px;cursor:pointer;margin:10px 0';
        button.addEventListener('click', resume);
        const diagnostic = doc.createElement('details'); diagnostic.style.cssText = 'text-align:left;margin-top:18px';
        const summary = doc.createElement('summary'); summary.textContent = 'Diagnostic details';
        details = doc.createElement('textarea'); details.readOnly = true; details.rows = 10;
        details.style.cssText = 'box-sizing:border-box;width:100%;margin-top:8px;font:11px monospace';
        details.setAttribute('aria-label', 'Suspend/resume diagnostic details');
        diagnostic.addEventListener('toggle', () => { if (diagnostic.open) details.value = JSON.stringify(report(), null, 2); });
        diagnostic.appendChild(summary); diagnostic.appendChild(details);
        box.appendChild(title); box.appendChild(text); box.appendChild(button); box.appendChild(diagnostic);
        panel.appendChild(box); doc.body.appendChild(panel);
      }
      panel.style.display = 'grid';
      title.textContent = state.fatal ? 'Game stopped' : 'Game paused';
      text.textContent = state.fatal ? state.lastError + ' Reopen Hollow Knight through Game Library. Existing saved data has not been deleted.' :
        state.graphicsPending ? 'Waiting for Unity to restore the graphics context. The game remains paused.' :
        state.phase === 'resuming' ? 'Resuming audio and game…' :
        state.lastError ? state.lastError + ' Tap Resume to retry.' :
        'Safari interrupted the session. Tap Resume when you are ready to continue.';
      button.textContent = state.phase === 'resuming' ? 'Resuming…' : 'Resume';
      button.hidden = Boolean(state.fatal);
      button.disabled = !state.ready || state.graphicsPending || state.phase === 'resuming';
      details.value = JSON.stringify(report(), null, 2);
    }

    function captureAudio() {
      const next = runtime && runtime.audio;
      if (!next || next === audio) return;
      if (audio) audio.removeEventListener('statechange', audioChanged);
      audio = next;
      state.audioState = audio.state;
      audio.addEventListener('statechange', audioChanged);
      if (audio.state === 'interrupted' && !state.paused) pause('audio-interrupted');
    }

    function suspendAudio() {
      if (!audio || audio.state === 'closed' || audio.state === 'suspended') return;
      // Do not close/recreate AudioContext: that invalidates Unity's node graph.
      try {
        Promise.resolve(audio.suspend()).catch(error => {
          state.lastError = 'Audio suspension failed: ' + String(error.message || error);
          record('audio-suspend-error'); show();
        });
      } catch (error) {
        state.lastError = 'Audio suspension failed: ' + String(error.message || error);
        record('audio-suspend-error'); show();
      }
    }

    function quiesce() {
      if (!runtime) return;
      const loop = runtime.loop;
      // Only resume a loop that this controller actually paused. This also
      // invalidates stale scheduled callbacks via Emscripten's generation ID.
      if (!ownLoopPause && loop.func && loop.scheduler) {
        ownLoopPause = true; loop.pause();
      }
      if (!ownCallbacksPause && runtime.callbacksAllowed) {
        ownCallbacksPause = true; runtime.pauseCallbacks();
      }
      captureAudio(); suspendAudio();
      if (global.__hkNeighborPreload) global.__hkNeighborPreload.suspend();
    }

    function pause(reason) {
      if (disposed) return;
      // Invalidate an unfinished resume on EVERY new suspension event.
      epoch += 1;
      if (!state.paused) state.suspends += 1;
      state.paused = true;
      if (!state.fatal) {
        state.reason = reason;
        state.phase = hidden() ? 'hidden' : state.graphicsPending ? 'waiting-for-graphics' : 'awaiting-resume';
      }
      quiesce(); record(reason); show();
    }

    function fail(code, message) {
      if (disposed || state.fatal) return;
      state.fatal = code; state.lastError = message;
      state.phase = 'failed'; state.reason = code;
      pause(code);
      console.error('Hollow Knight stopped:', code, message);
    }

    function audioChanged() {
      state.audioState = audio.state;
      if (state.paused || hidden()) {
        if (audio.state === 'running' && state.phase !== 'resuming') suspendAudio();
      } else if (audio.state === 'interrupted') {
        pause('audio-interrupted');
      }
      // A statechange need not mean the game can resume. Only an explicit
      // successful Resume attempt releases the game and deferred callbacks.
    }

    function requestAudioResume() {
      captureAudio();
      if (!audio || audio.state === 'running' || audio.state === 'closed' ||
          state.paused || hidden() || pendingAudio || disposed) return;
      try {
        const task = Promise.resolve(audio.resume());
        pendingAudio = task;
        task.catch(error => {
          state.lastError = 'Audio resume failed: ' + String(error.message || error);
          record('audio-auto-resume-error');
        }).finally(() => { if (pendingAudio === task) pendingAudio = null; });
      } catch (error) {
        state.lastError = 'Audio resume failed: ' + String(error.message || error);
        record('audio-auto-resume-error');
      }
    }

    async function resume() {
      if (disposed || !state.paused || !state.ready || hidden() || state.fatal || state.graphicsPending || state.phase === 'resuming') return false;
      if (runtime.aborted || global.__hkLastReadFailure) {
        fail('runtime-failed', 'Unity has already reported a fatal error.'); return false;
      }
      if (module.ctx && module.ctx.isContextLost()) {
        contextLost(); return false;
      }
      const token = ++epoch;
      state.phase = 'resuming'; state.lastError = '';
      record('resume-request'); show(); captureAudio();
      let timer = null, releasedEngine = false;
      try {
        if (audio && audio.state !== 'running') {
          if (audio.state === 'closed') throw new Error('The game’s audio context has closed.');
          // Call resume synchronously IN the click handler. An earlier autoplay
          // request may remain pending on iOS; do not reuse that old Promise.
          const task = Promise.resolve(audio.resume());
          await Promise.race([task, new Promise((_, reject) => {
            timer = view.setTimeout(() => reject(new Error('Safari has not resumed audio yet.')), AUDIO_WAIT_MS);
          })]);
          if (audio.state !== 'running') throw new Error('Safari is still interrupting audio.');
        }
        if (token !== epoch || hidden() || disposed || state.fatal) return false;
        if (runtime.aborted || global.__hkLastReadFailure) throw new Error('Unity reported an error during resume.');
        if (module.ctx && module.ctx.isContextLost()) {
          contextLost(); return false;
        }
        // The GPU/audio checks complete before any suspended engine work runs.
        releasedEngine = true;
        state.paused = false; state.phase = 'running'; state.reason = ''; 
        if (ownCallbacksPause) { ownCallbacksPause = false; runtime.resumeCallbacks(); }
        if (runtime.aborted && !state.fatal) fail('runtime-failed', 'Unity stopped while resuming callbacks.');
        if (state.paused || state.fatal) return false;
        if (ownLoopPause) { ownLoopPause = false; runtime.loop.resume(); }
        if (global.__hkNeighborPreload) global.__hkNeighborPreload.resume();
        state.resumes += 1; record('resume-complete');
        doc.dispatchEvent(new view.Event('hk-game-resumed'));
        if (panel) panel.style.display = 'none';
        canvas.focus({ preventScroll: true });
        return true;
      } catch (error) {
        if (token !== epoch || disposed || state.fatal) return false;
        if (releasedEngine) {
          fail('resume-callback-error', String(error.message || error)); return false;
        }
        state.paused = true; state.phase = 'awaiting-resume';
        state.lastError = String(error.message || error);
        quiesce(); record('resume-failed'); show();
        return false;
      } finally {
        if (timer !== null) view.clearTimeout(timer);
      }
    }

    function visibility() {
      if (hidden()) pause('visibility-hidden');
      else if (state.paused) {
        if (!state.fatal && state.phase !== 'resuming') state.phase = state.graphicsPending ? 'waiting-for-graphics' : 'awaiting-resume';
        record('visible'); show();
      }
    }
    function pagehide(event) { hiddenViews.add(event.currentTarget); pause('pagehide'); }
    function pageshow(event) { hiddenViews.delete(event.currentTarget); visibility(); }
    function freeze(event) { frozenDocuments.add(event.currentTarget); pause('freeze'); }
    function thaw(event) { frozenDocuments.delete(event.currentTarget); visibility(); }
    function contextLost() {
      // Preserve an existing native Unity restoration path, when registered.
      // Never synthesize GPU resources or assume a restored buffer is enough.
      if (runtime && runtime.contextRestoreRegistered && !state.fatal) {
        state.graphicsPending = true;
        pause('webgl-context-lost');
      } else {
        fail('webgl-context-lost', 'Safari lost the game’s graphics resources; this instance has no registered Unity restoration handler.');
      }
    }
    function contextRestored() {
      // Our listener is installed first. Wait until Unity's own event handlers
      // have run before allowing a Resume tap. Do not preempt their recovery.
      Promise.resolve().then(() => {
        if (disposed) return;
        record('webgl-context-restored');
        if (state.graphicsPending && !state.fatal) {
          if (!runtime.contextRestoreRegistered || runtime.aborted) {
            fail('graphics-restore-failed', 'Unity could not complete its graphics restoration.');
          } else if (module.ctx && !module.ctx.isContextLost()) {
            state.graphicsPending = false;
            state.phase = hidden() ? 'hidden' : 'awaiting-resume';
          }
        }
        show();
      });
    }

    const controller = {
      version: VERSION, state, report, resume, pause, requestAudioResume,
      bind(unityModule) {
        module = unityModule; runtime = module.__hkRuntime;
        if (!runtime || runtime.version !== VERSION) throw new Error('Unity suspend/resume bridge is unavailable.');
        module.__hkLifecycle = controller;
        if (state.paused || hidden()) pause('bind-hidden');
      },
      beforeFrame() {
        if (disposed) return false;
        if (hidden() && !state.paused) pause('frame-hidden');
        if (state.paused) { quiesce(); return false; }
        if (!audio) captureAudio();
        return !state.paused;
      },
      audioTick(timer) {
        captureAudio();
        if (audio && audio.state === 'running') module.clearInterval(timer);
        else requestAudioResume();
      },
      ready() {
        state.ready = true;
        if (state.paused || hidden()) { if (!state.paused) pause('ready-hidden'); show(); }
        else { state.phase = 'running'; record('ready'); }
      },
      runtimeError(error) {
        fail('unity-error', String(error && error.message ? error.message : error));
        return true; // Replaced popup with explicit fatal panel, not a recovery.
      },
      cleanup() {
        if (disposed) return;
        pause('cleanup'); disposed = true; state.phase = 'disposed';
        for (const documentRef of documents) {
          documentRef.removeEventListener('visibilitychange', visibility, true);
          documentRef.removeEventListener('freeze', freeze, true);
          documentRef.removeEventListener('resume', thaw, true);
        }
        for (const windowRef of views) {
          windowRef.removeEventListener('pagehide', pagehide, true);
          windowRef.removeEventListener('pageshow', pageshow, true);
        }
        canvas.removeEventListener('webglcontextlost', contextLost, true);
        canvas.removeEventListener('webglcontextrestored', contextRestored, true);
        if (audio) audio.removeEventListener('statechange', audioChanged);
        if (panel) panel.remove();
        if (global.__hkLifecycle === controller) delete global.__hkLifecycle;
      }
    };
    for (const documentRef of documents) {
      documentRef.addEventListener('visibilitychange', visibility, true);
      documentRef.addEventListener('freeze', freeze, true);
      documentRef.addEventListener('resume', thaw, true);
    }
    for (const windowRef of views) {
      windowRef.addEventListener('pagehide', pagehide, true);
      windowRef.addEventListener('pageshow', pageshow, true);
    }
    canvas.addEventListener('webglcontextlost', contextLost, true);
    canvas.addEventListener('webglcontextrestored', contextRestored, true);
    global.__hkLifecycle = controller;
    if (hidden()) pause('initially-hidden');
    return controller;
  };
})(window);
