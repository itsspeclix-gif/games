(function (global) {
  'use strict';

  const MAGIC = 'UnityWebData1.0\0';
  const HEADER_PREFIX_SIZE = MAGIC.length + 4;
  const CACHE_LIMIT = 60 * 1024 * 1024;

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

  async function fetchBytes(url) {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error('Could not load ' + url + ' (' + response.status + ')');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  function syncWhole(url, stats) {
    const started = performance.now();
    let xhr = new XMLHttpRequest();
    let text = '';

    stats.activePart = url.split('/').pop() || url;
    stats.phase = 'sync-read';
    setMessage('Streaming ' + stats.activePart + '…');

    try {
      xhr.open('GET', url, false);
      if (xhr.overrideMimeType) {
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
      }
      xhr.send(null);
    } catch (error) {
      stats.activePart = '';
      throw new Error('StabilityFS whole-file XHR failed: ' + errorText(error));
    }

    if (
      !(xhr.status >= 200 && xhr.status < 300) &&
      xhr.status !== 304 &&
      xhr.status !== 0
    ) {
      const status = xhr.status;
      stats.activePart = '';
      throw new Error('StabilityFS HTTP ' + status + ' for ' + url);
    }

    text = xhr.responseText || '';
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index) & 255;
    }

    stats.syncPartLoads += 1;
    stats.syncBytes += bytes.byteLength;
    stats.syncBlockedMs += performance.now() - started;
    stats.activePart = '';

    // Shorten the lifetime of the large temporary response string.
    text = '';
    xhr = null;

    return bytes;
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
    const cache = new Map();
    const demandedParts = new Set();
    const touchedFiles = new Set();
    let residentBytes = 0;

    const stats = global.__hkLazyStats = {
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

      const bytes = await fetchBytes(urls[partIndex]);
      return storePart(partIndex, bytes);
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
        bytes = syncWhole(urls[partIndex], stats);
      } catch (error) {
        stats.lastError = errorText(error);
        throw error;
      }

      return storePart(partIndex, bytes);
    }

    function readInto(entry, filePosition, length, target, targetOffset) {
      if (length <= 0 || filePosition >= entry.size) return 0;
      if (filePosition < 0) {
        throw new Error('StabilityFS: negative file position for ' + entry.name);
      }

      let remaining = Math.min(length, entry.size - filePosition);
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
            stats.lastError = errorText(error);
            throw error;
          } finally {
            stats.activeFile = '';
          }
        },

        mmap(stream, buffer, address, length, position) {
          stats.activeFile = entry.name;
          stats.phase = 'mmap';
          stats.mmapCalls += 1;

          const pointer = module._malloc(length);
          if (!pointer) {
            stats.lastError =
              'StabilityFS: WASM malloc failed while mapping ' + entry.name;
            stats.activeFile = '';
            throw new FS.ErrnoError(12);
          }

          try {
            const count = readInto(
              entry,
              position,
              length,
              buffer,
              pointer
            );
            if (count < length) {
              buffer.fill(0, pointer + count, pointer + length);
            }
            stats.mmapBytes += length;
            return { ptr: pointer, allocated: true };
          } catch (error) {
            module._free(pointer);
            stats.lastError = errorText(error);
            throw error;
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
