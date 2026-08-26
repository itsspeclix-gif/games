(function (global) {
  'use strict';

  const MAGIC = 'UnityWebData1.0\0';
  const HEADER_PREFIX_SIZE = MAGIC.length + 4;

  function fail(message) {
    throw new Error(`Invalid Unity data archive: ${message}`);
  }

  function readString(bytes, offset, length) {
    let value = '';
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(bytes[offset + index]);
    }
    return value;
  }

  function validateMagic(bytes) {
    if (bytes.byteLength < HEADER_PREFIX_SIZE) {
      fail('the first part is too small to contain the archive header');
    }
    if (readString(bytes, 0, MAGIC.length) !== MAGIC) {
      fail('unexpected archive magic');
    }
  }

  function parseUnityDataArchive(bytes, totalSize) {
    validateMagic(bytes);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerEnd = view.getUint32(MAGIC.length, true);
    if (headerEnd < HEADER_PREFIX_SIZE || headerEnd > totalSize) {
      fail('header extends outside the split archive');
    }
    if (headerEnd > bytes.byteLength) {
      fail('the supplied header bytes are incomplete');
    }

    const entries = [];
    let position = HEADER_PREFIX_SIZE;
    while (position < headerEnd) {
      if (position + 12 > headerEnd) fail('truncated file record');

      const offset = view.getUint32(position, true);
      position += 4;
      const size = view.getUint32(position, true);
      position += 4;
      const nameLength = view.getUint32(position, true);
      position += 4;

      if (nameLength > headerEnd - position) fail('truncated file name');
      if (offset > totalSize || size > totalSize - offset) {
        fail('file extent extends outside the split archive');
      }

      const name = readString(bytes, position, nameLength);
      position += nameLength;
      entries.push({ offset, size, name });
    }

    if (position !== headerEnd) fail('header did not end on a file boundary');
    return { headerEnd, entries };
  }

  function createPartFetcher(urls, partSize) {
    return async function fetchPart(index) {
      const url = urls[index];
      if (!url) throw new Error(`Missing Unity data part ${index + 1}`);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load Unity data part ${index + 1} (${response.status})`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error(`Unity data part ${index + 1} was empty`);
      }
      if (index < urls.length - 1 && bytes.byteLength !== partSize) {
        throw new Error(`Unity data part ${index + 1} had an unexpected size`);
      }
      return bytes;
    };
  }

  async function loadHeader(firstPart, fetchPart, partSize, totalSize) {
    validateMagic(firstPart);
    const firstView = new DataView(
      firstPart.buffer,
      firstPart.byteOffset,
      firstPart.byteLength
    );
    const headerEnd = firstView.getUint32(MAGIC.length, true);
    if (headerEnd < HEADER_PREFIX_SIZE || headerEnd > totalSize) {
      fail('header extends outside the split archive');
    }
    if (headerEnd <= firstPart.byteLength) {
      return firstPart.subarray(0, headerEnd);
    }

    const header = new Uint8Array(headerEnd);
    let copied = 0;
    let partIndex = 0;
    while (copied < headerEnd) {
      const part = partIndex === 0 ? firstPart : await fetchPart(partIndex);
      const count = Math.min(part.byteLength, headerEnd - copied);
      header.set(part.subarray(0, count), copied);
      copied += count;
      partIndex += 1;
    }
    return header;
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

  function reportProgress(callback, state, force) {
    if (!callback) return;
    const now = global.performance && global.performance.now
      ? global.performance.now()
      : Date.now();
    if (force || now - state.lastReportAt >= 125) {
      state.lastReportAt = now;
      callback(state.value);
    }
  }

  async function mountUnityDataParts(module, urls, options) {
    if (!module || typeof module.FS_createDataFile !== 'function') {
      throw new Error('Unity filesystem APIs were not initialized');
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error('No Unity data parts were provided');
    }

    let firstPart = new Uint8Array(await (async () => {
      const response = await fetch(urls[0]);
      if (!response.ok) {
        throw new Error(`Could not load Unity data part 1 (${response.status})`);
      }
      return response.arrayBuffer();
    })());
    if (firstPart.byteLength === 0) throw new Error('Unity data part 1 was empty');

    const partSize = firstPart.byteLength;
    const fetchPart = createPartFetcher(urls, partSize);
    let finalPart = firstPart;
    if (urls.length > 1) finalPart = await fetchPart(urls.length - 1);
    const totalSize = partSize * (urls.length - 1) + finalPart.byteLength;
    finalPart = null;

    const progress = options && options.onProgress;
    const progressState = {
      lastReportAt: 0,
      value: { phase: 'archive', filesMounted: 0, totalFiles: 0 }
    };
    reportProgress(progress, progressState, true);

    let header = await loadHeader(firstPart, fetchPart, partSize, totalSize);
    const parsed = parseUnityDataArchive(header, totalSize);
    header = null;

    const entries = parsed.entries.slice().sort((left, right) => left.offset - right.offset);
    progressState.value = {
      phase: 'mounting',
      filesMounted: 0,
      totalFiles: entries.length
    };
    reportProgress(progress, progressState, true);

    let currentPartIndex = 0;
    let currentPart = firstPart;
    firstPart = null;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      let fileBytes = new Uint8Array(entry.size);
      let sourceOffset = entry.offset;
      let targetOffset = 0;
      let remaining = entry.size;

      while (remaining > 0) {
        const partIndex = Math.floor(sourceOffset / partSize);
        const offsetInPart = sourceOffset % partSize;
        if (partIndex >= urls.length) fail('file points beyond the last data part');
        if (partIndex !== currentPartIndex) {
          currentPart = await fetchPart(partIndex);
          currentPartIndex = partIndex;
        }
        if (offsetInPart >= currentPart.byteLength) {
          fail('file points beyond the current data part');
        }

        const count = Math.min(remaining, currentPart.byteLength - offsetInPart);
        fileBytes.set(currentPart.subarray(offsetInPart, offsetInPart + count), targetOffset);
        sourceOffset += count;
        targetOffset += count;
        remaining -= count;
      }

      createDirectories(module, entry.name);
      module.FS_createDataFile(entry.name, null, fileBytes, true, true, true);
      fileBytes = null;

      progressState.value = {
        phase: 'mounting',
        filesMounted: entryIndex + 1,
        totalFiles: entries.length
      };
      reportProgress(progress, progressState, entryIndex + 1 === entries.length);
    }

    currentPart = null;
    progressState.value = {
      phase: 'complete',
      filesMounted: entries.length,
      totalFiles: entries.length
    };
    reportProgress(progress, progressState, true);
  }

  global.mountUnityDataParts = mountUnityDataParts;
  global.HollowKnightMultipartData = {
    mountUnityDataParts,
    parseUnityDataArchive
  };
})(typeof window !== 'undefined' ? window : globalThis);
