(function (global) {
  'use strict';

  const MAGIC = 'UnityWebData1.0\0';
  const HEADER_PREFIX_SIZE = MAGIC.length + 4;
  const BLOCK_SIZE = 2 * 1024 * 1024;
  const RANGE_CACHE_LIMIT = 40 * 1024 * 1024;
  const WHOLE_CACHE_LIMIT = 42 * 1024 * 1024;
  const PREFETCH_OPEN_BLOCKS = 3;
  const PREFETCH_SEQ_BLOCKS = 4;
  const PREFETCH_COLD_BLOCKS = 1;

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function readString(bytes, offset, length) {
    let value = '';
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(bytes[offset + index]);
    }
    return value;
  }

  function validateMagic(bytes) {
    if (bytes.byteLength < HEADER_PREFIX_SIZE || readString(bytes, 0, MAGIC.length) !== MAGIC) {
      throw new Error('StabilityFS: unexpected UnityWebData archive header');
    }
  }

  function parseArchive(header, totalSize) {
    validateMagic(header);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const headerEnd = view.getUint32(MAGIC.length, true);

    if (headerEnd < HEADER_PREFIX_SIZE || headerEnd > totalSize || headerEnd > header.byteLength) {
      throw new Error('StabilityFS: invalid archive header length');
    }

    const entries = [];
    let position = HEADER_PREFIX_SIZE;
    while (position < headerEnd) {
      if (position + 12 > headerEnd) throw new Error('StabilityFS: truncated archive record');
      const offset = view.getUint32(position, true); position += 4;
      const size = view.getUint32(position, true); position += 4;
      const nameLength = view.getUint32(position, true); position += 4;
      if (nameLength > headerEnd - position) throw new Error('StabilityFS: truncated archive filename');
      const name = readString(header, position, nameLength); position += nameLength;
      if (offset > totalSize || size > totalSize - offset) {
        throw new Error('StabilityFS: archive entry outside data file');
      }
      entries.push({ offset, size, name });
    }

    if (position !== headerEnd) throw new Error('StabilityFS: malformed archive header');
    return entries;
  }

  function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
    return match ? {
      start: Number(match[1]),
      end: Number(match[2]),
      total: match[3] === '*' ? null : Number(match[3])
    } : null;
  }

  function withHost(url, host) {
    const parsed = new URL(url);
    parsed.host = host;
    return parsed.href;
  }

  async function fetchBytes(url) {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error('Could not load ' + url + ' (' + response.status + ')');
    return new Uint8Array(await response.arrayBuffer());
  }

  async function asyncRange(url, start, end, host) {
    const response = await fetch(withHost(url, host), {
      headers: { Range: 'bytes=' + start + '-' + end },
      cache: 'force-cache'
    });
    if (response.status !== 206) throw new Error('expected HTTP 206 from ' + host + ', got ' + response.status);
    const range = parseContentRange(response.headers.get('Content-Range'));
    if (!range || range.start !== start || range.end !== end) {
      throw new Error('invalid Content-Range from ' + host);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - start + 1) throw new Error('range byte count mismatch from ' + host);
    return { bytes, total: range.total };
  }

  async function chooseRangeHost(url) {
    const candidates = [...new Set([new URL(url).host, 'fastly.jsdelivr.net'])];
    const errors = [];

    for (const host of candidates) {
      try {
        const first = await asyncRange(url, 0, 63, host);
        const middle = await asyncRange(url, 16, 31, host);
        validateMagic(first.bytes);
        for (let index = 0; index < middle.bytes.length; index += 1) {
          if (middle.bytes[index] !== first.bytes[index + 16]) {
            throw new Error('range bytes were shifted or corrupt');
          }
        }
        return { host, total: first.total };
      } catch (error) {
        errors.push(host + ': ' + errorText(error));
      }
    }
    throw new Error(errors.join(' | '));
  }

  function syncRange(url, start, end, host) {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', withHost(url, host), false);
      xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
      if (xhr.overrideMimeType) xhr.overrideMimeType('text/plain; charset=x-user-defined');
      xhr.send(null);
    } catch (error) {
      throw new Error('synchronous Range XHR rejected: ' + errorText(error));
    }

    if (xhr.status !== 206) throw new Error('synchronous Range expected 206, got ' + xhr.status);
    const range = parseContentRange(xhr.getResponseHeader('Content-Range'));
    if (!range || range.start !== start || range.end !== end) {
      throw new Error('synchronous Range returned invalid Content-Range');
    }

    const text = xhr.responseText || '';
    const expected = end - start + 1;
    if (text.length !== expected) {
      throw new Error('synchronous Range length mismatch: expected ' + expected + ', got ' + text.length);
    }
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 255;
    return bytes;
  }

  function syncWhole(url) {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', url, false);
      if (xhr.overrideMimeType) xhr.overrideMimeType('text/plain; charset=x-user-defined');
      xhr.send(null);
    } catch (error) {
      throw new Error('whole-part XHR failed: ' + errorText(error));
    }
    if (!(xhr.status >= 200 && xhr.status < 300) && xhr.status !== 304 && xhr.status !== 0) {
      throw new Error('whole-part HTTP ' + xhr.status + ' for ' + url);
    }
    const text = xhr.responseText || '';
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 255;
    return bytes;
  }

  function createDirectories(module, fileName) {
    for (let start = 0, slash = fileName.indexOf('/', start) + 1; slash > 0; start = slash, slash = fileName.indexOf('/', start) + 1) {
      module.FS_createPath(fileName.substring(0, start), fileName.substring(start, slash - 1), true, true);
    }
  }

  async function headerFromRanges(urls, partSize, totalSize, host) {
    const prefix = await asyncRange(urls[0], 0, HEADER_PREFIX_SIZE - 1, host);
    validateMagic(prefix.bytes);
    const headerEnd = new DataView(prefix.bytes.buffer, prefix.bytes.byteOffset, prefix.bytes.byteLength)
      .getUint32(MAGIC.length, true);
    if (headerEnd < HEADER_PREFIX_SIZE || headerEnd > totalSize) {
      throw new Error('StabilityFS: invalid header extent');
    }

    const header = new Uint8Array(headerEnd);
    let archiveOffset = 0;
    let targetOffset = 0;
    while (targetOffset < headerEnd) {
      const partIndex = Math.floor(archiveOffset / partSize);
      const offsetInPart = archiveOffset % partSize;
      const length = Math.min(headerEnd - targetOffset, partSize - offsetInPart);
      const result = await asyncRange(urls[partIndex], offsetInPart, offsetInPart + length - 1, host);
      header.set(result.bytes, targetOffset);
      archiveOffset += length;
      targetOffset += length;
    }
    return header;
  }

  async function headerFromWholeParts(urls, firstPart, totalSize) {
    validateMagic(firstPart);
    const headerEnd = new DataView(firstPart.buffer, firstPart.byteOffset, firstPart.byteLength)
      .getUint32(MAGIC.length, true);
    if (headerEnd < HEADER_PREFIX_SIZE || headerEnd > totalSize) {
      throw new Error('StabilityFS: invalid header extent');
    }
    if (headerEnd <= firstPart.byteLength) return firstPart.slice(0, headerEnd);

    const header = new Uint8Array(headerEnd);
    let copied = 0;
    let partIndex = 0;
    while (copied < headerEnd) {
      const part = partIndex === 0 ? firstPart : await fetchBytes(urls[partIndex]);
      const count = Math.min(part.byteLength, headerEnd - copied);
      header.set(part.subarray(0, count), copied);
      copied += count;
      partIndex += 1;
    }
    return header;
  }

  async function mountUnityDataParts(module, urls, options) {
    if (!module || !module.__FS || typeof module.FS_createDataFile !== 'function') {
      throw new Error('StabilityFS: patched Emscripten FS was not exported');
    }
    if (!Array.isArray(urls) || urls.length === 0) throw new Error('StabilityFS: no data part URLs');

    const FS = module.__FS;
    const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;
    let transport = 'whole';
    let rangeHost = '';
    let partSize = 0;
    let partLengths = null;
    let totalSize = 0;
    let header;

    const rangeCache = new Map();
    const rangePrefetching = new Map();
    const wholeCache = new Map();
    const wholePrefetching = new Map();

    try {
      const choice = await chooseRangeHost(urls[0]);
      rangeHost = choice.host;
      // Safari can pass async fetch checks but reject the synchronous mechanism Unity needs.
      if (syncRange(urls[0], 0, 0, rangeHost).byteLength !== 1) {
        throw new Error('synchronous Range probe returned wrong size');
      }
      const first = await asyncRange(urls[0], 0, 0, rangeHost);
      const last = await asyncRange(urls[urls.length - 1], 0, 0, rangeHost);
      if (!first.total || !last.total) throw new Error('range transport did not expose file lengths');
      transport = 'range';
      partSize = first.total;
      partLengths = new Array(urls.length).fill(partSize);
      partLengths[partLengths.length - 1] = last.total;
      totalSize = partSize * (urls.length - 1) + last.total;
      header = await headerFromRanges(urls, partSize, totalSize, rangeHost);
    } catch (_) {
      const firstPart = await fetchBytes(urls[0]);
      const finalPart = urls.length === 1 ? firstPart : await fetchBytes(urls[urls.length - 1]);
      if (!firstPart.byteLength) throw new Error('StabilityFS: first data part is empty');
      partSize = firstPart.byteLength;
      partLengths = new Array(urls.length).fill(partSize);
      partLengths[partLengths.length - 1] = finalPart.byteLength;
      totalSize = partSize * (urls.length - 1) + finalPart.byteLength;
      wholeCache.set(0, { bytes: firstPart });
      header = await headerFromWholeParts(urls, firstPart, totalSize);
    }

    const entries = parseArchive(header, totalSize);
    const cacheBytes = cache => {
      let total = 0;
      for (const record of cache.values()) total += record.bytes.byteLength;
      return total;
    };
    const touch = (cache, key, record) => {
      cache.delete(key);
      cache.set(key, record);
      return record.bytes;
    };
    const trim = (cache, limit, keepKey) => {
      while (cacheBytes(cache) > limit && cache.size > 1) {
        const victim = [...cache.keys()].find(key => key !== keepKey);
        if (victim === undefined) return;
        cache.delete(victim);
      }
    };
    const store = (cache, key, bytes, limit) => {
      const existing = cache.get(key);
      if (existing) return touch(cache, key, existing);
      const record = { bytes };
      cache.set(key, record);
      touch(cache, key, record);
      trim(cache, limit, key);
      return bytes;
    };
    const blockCount = partIndex => Math.ceil(partLengths[partIndex] / BLOCK_SIZE);
    const blockBounds = (partIndex, blockIndex) => {
      const start = blockIndex * BLOCK_SIZE;
      if (start >= partLengths[partIndex]) throw new Error('StabilityFS: block outside data part');
      return { start, end: Math.min(partLengths[partIndex] - 1, start + BLOCK_SIZE - 1) };
    };
    const advanceBlock = (partIndex, blockIndex, count) => {
      let part = partIndex;
      let block = blockIndex;
      for (let step = 0; step < count; step += 1) {
        block += 1;
        while (part < partLengths.length && block >= blockCount(part)) {
          part += 1;
          block = 0;
        }
        if (part >= partLengths.length) return null;
      }
      return { partIndex: part, blockIndex: block };
    };
    const rangeKey = (partIndex, blockIndex) => partIndex + ':' + blockIndex;

    const scheduleRangeBlock = (partIndex, blockIndex) => {
      if (partIndex < 0 || partIndex >= partLengths.length) return;
      const key = rangeKey(partIndex, blockIndex);
      if (rangeCache.has(key) || rangePrefetching.has(key)) return;
      let bounds;
      try { bounds = blockBounds(partIndex, blockIndex); } catch (_) { return; }
      const request = asyncRange(urls[partIndex], bounds.start, bounds.end, rangeHost)
        .then(result => store(rangeCache, key, result.bytes, RANGE_CACHE_LIMIT))
        .catch(() => {})
        .finally(() => rangePrefetching.delete(key));
      rangePrefetching.set(key, request);
    };
    const prefetchRange = (partIndex, blockIndex, count, includeCurrent) => {
      let location = includeCurrent ? { partIndex, blockIndex } : advanceBlock(partIndex, blockIndex, 1);
      for (let index = 0; index < count && location; index += 1) {
        scheduleRangeBlock(location.partIndex, location.blockIndex);
        location = advanceBlock(location.partIndex, location.blockIndex, 1);
      }
    };
    const getRangeBlock = (partIndex, blockIndex, prefetchAhead) => {
      const key = rangeKey(partIndex, blockIndex);
      const cached = rangeCache.get(key);
      if (cached) {
        const bytes = touch(rangeCache, key, cached);
        if (prefetchAhead) prefetchRange(partIndex, blockIndex, prefetchAhead, false);
        return bytes;
      }
      const bounds = blockBounds(partIndex, blockIndex);
      const bytes = syncRange(urls[partIndex], bounds.start, bounds.end, rangeHost);
      store(rangeCache, key, bytes, RANGE_CACHE_LIMIT);
      if (prefetchAhead) prefetchRange(partIndex, blockIndex, prefetchAhead, false);
      return bytes;
    };
    const scheduleWholePart = partIndex => {
      if (partIndex < 0 || partIndex >= urls.length || wholeCache.has(partIndex) || wholePrefetching.has(partIndex)) return;
      const request = fetchBytes(urls[partIndex])
        .then(bytes => store(wholeCache, partIndex, bytes, WHOLE_CACHE_LIMIT))
        .catch(() => {})
        .finally(() => wholePrefetching.delete(partIndex));
      wholePrefetching.set(partIndex, request);
    };
    const getWholePart = (partIndex, prefetchNext) => {
      const cached = wholeCache.get(partIndex);
      if (cached) {
        const bytes = touch(wholeCache, partIndex, cached);
        if (prefetchNext) scheduleWholePart(partIndex + 1);
        return bytes;
      }
      const bytes = syncWhole(urls[partIndex]);
      store(wholeCache, partIndex, bytes, WHOLE_CACHE_LIMIT);
      if (prefetchNext) scheduleWholePart(partIndex + 1);
      return bytes;
    };
    const warmEntry = entry => {
      if (!entry || entry.size <= 0) return;
      const partIndex = Math.floor(entry.offset / partSize);
      if (transport === 'range') {
        if (entry.size >= 4 * 1024 * 1024 || /\.(resource|resources|unity3d|resS)$/i.test(entry.name)) {
          prefetchRange(partIndex, Math.floor((entry.offset % partSize) / BLOCK_SIZE), PREFETCH_OPEN_BLOCKS, true);
        }
      } else {
        scheduleWholePart(partIndex);
        if (entry.size >= partSize / 2) scheduleWholePart(partIndex + 1);
      }
    };
    const readInto = (entry, filePosition, length, target, targetOffset) => {
      if (length <= 0 || filePosition >= entry.size) return 0;
      if (filePosition < 0) throw new Error('StabilityFS: negative file position');
      const previousEnd = entry.__hkLastReadEnd;
      const sequential = typeof previousEnd === 'number' && filePosition >= previousEnd && filePosition - previousEnd <= BLOCK_SIZE;
      entry.__hkSequentialReads = sequential ? (entry.__hkSequentialReads || 0) + 1 : 0;
      const prefetchAhead = entry.__hkSequentialReads >= 2 ? PREFETCH_SEQ_BLOCKS : PREFETCH_COLD_BLOCKS;
      let remaining = Math.min(length, entry.size - filePosition);
      let archiveOffset = entry.offset + filePosition;
      let destination = targetOffset;
      while (remaining > 0) {
        const partIndex = Math.floor(archiveOffset / partSize);
        const offsetInPart = archiveOffset % partSize;
        let source;
        let sourceOffset;
        if (transport === 'range') {
          const blockIndex = Math.floor(offsetInPart / BLOCK_SIZE);
          source = getRangeBlock(partIndex, blockIndex, prefetchAhead);
          sourceOffset = offsetInPart % BLOCK_SIZE;
        } else {
          source = getWholePart(partIndex, sequential);
          sourceOffset = offsetInPart;
        }
        const count = Math.min(remaining, source.byteLength - sourceOffset);
        if (count <= 0) throw new Error('StabilityFS: invalid zero-length data read');
        target.set(source.subarray(sourceOffset, sourceOffset + count), destination);
        archiveOffset += count;
        destination += count;
        remaining -= count;
      }
      const read = destination - targetOffset;
      entry.__hkLastReadEnd = filePosition + read;
      return read;
    };

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      createDirectories(module, entry.name);
      module.FS_createDataFile(entry.name, null, new Uint8Array(0), true, true, true);
      const node = FS.lookupPath(entry.name).node;
      node.usedBytes = entry.size;
      node.contents = null;
      const baseOps = node.stream_ops;
      const operations = Object.assign({}, baseOps, {
        open() { warmEntry(entry); },
        read(stream, buffer, offset, length, position) {
          return readInto(entry, position, length, buffer, offset);
        },
        mmap(stream, buffer, address, length, position) {
          const pointer = module._malloc(length);
          if (!pointer) throw new FS.ErrnoError(12);
          try {
            const read = readInto(entry, position, length, buffer, pointer);
            if (read < length) buffer.fill(0, pointer + read, pointer + length);
            return { ptr: pointer, allocated: true };
          } catch (error) {
            module._free(pointer);
            throw error;
          }
        },
        write() { throw new FS.ErrnoError(30); }
      });
      node.stream_ops = operations;
      if (onProgress && (index % 20 === 0 || index + 1 === entries.length)) {
        onProgress({ phase: 'mounting', filesMounted: index + 1, totalFiles: entries.length });
      }
    }
    if (onProgress) onProgress({ phase: 'complete', filesMounted: entries.length, totalFiles: entries.length });
  }

  function installHollowKnightPersistence(module) {
    if (!module || module.__hkPersistenceInstalled) return Boolean(module && module.__hkPersistenceInstalled);
    const FS = module.__FS;
    if (!FS || !FS.trackingDelegate || typeof FS.syncfs !== 'function') return false;

    const view = module.canvas && module.canvas.ownerDocument
      ? module.canvas.ownerDocument.defaultView
      : global;
    const documentRef = view && view.document;
    const previousWrite = FS.trackingDelegate.onWriteToFile;
    const previousMove = FS.trackingDelegate.onMovePath;
    const previousDelete = FS.trackingDelegate.onDeletePath;
    const isPersistentPath = path => typeof path === 'string' && (path === '/idbfs' || path.indexOf('/idbfs/') === 0);
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
      try { if (typeof previousWrite === 'function') previousWrite.apply(this, arguments); } catch (_) {}
      markDirty(path);
    };
    FS.trackingDelegate.onMovePath = function (oldPath, newPath) {
      try { if (typeof previousMove === 'function') previousMove.apply(this, arguments); } catch (_) {}
      markDirty(oldPath);
      markDirty(newPath);
    };
    FS.trackingDelegate.onDeletePath = function (path) {
      try { if (typeof previousDelete === 'function') previousDelete.apply(this, arguments); } catch (_) {}
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

  function installHollowKnightKeyboardBridge(canvas) {
    if (!canvas || canvas.__hkKeyboardBridgeInstalled) return Boolean(canvas && canvas.__hkKeyboardBridgeInstalled);
    const gameDocument = canvas.ownerDocument;
    const gameWindow = gameDocument && gameDocument.defaultView;
    if (!gameWindow) return false;
    canvas.tabIndex = 0;

    const focusCanvas = () => {
      try { gameWindow.focus(); } catch (_) {}
      try { canvas.focus({ preventScroll: true }); } catch (_) { try { canvas.focus(); } catch (_) {} }
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
      if (event.view === gameWindow || (event.target && event.target.ownerDocument === gameDocument)) return;
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
        const parentDocument = parentWindow.document;
        ancestorDocuments.push(parentDocument);
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
      gameDocument.addEventListener(type, focusCanvas, type === 'touchstart' ? { capture: true, passive: true } : true);
    }
    gameDocument.addEventListener('visibilitychange', () => {
      if (!gameDocument.hidden) gameWindow.setTimeout(focusCanvas, 0);
    });
    gameWindow.addEventListener('focus', () => gameWindow.setTimeout(focusCanvas, 0), true);
    canvas.__hkKeyboardBridgeInstalled = true;
    focusCanvas();
    return true;
  }

  global.mountUnityDataParts = mountUnityDataParts;
  global.installHollowKnightPersistence = installHollowKnightPersistence;
  global.installHollowKnightKeyboardBridge = installHollowKnightKeyboardBridge;
})(window);
