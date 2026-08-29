const originalFetch = window.fetch.bind(window);

const EXPECTED_PCK = 344705792;
const EXPECTED_WASM = 43444261;
const EXPECTED_TOTAL = EXPECTED_PCK + EXPECTED_WASM;

let downloadedBytes = 0;

function setLoadingText(text) {
    const el = document.getElementById("loading-text");
    if (el) el.textContent = text;
}

function formatMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
}

async function downloadPart(path) {
    const url = new URL(path, document.baseURI);

    const response = await originalFetch(url, {
        cache: "force-cache"
    });

    if (!response.ok) {
        throw new Error(
            `${path} failed: HTTP ${response.status}`
        );
    }

    const buffer = await response.arrayBuffer();

    downloadedBytes += buffer.byteLength;

    setLoadingText(
        `Downloading Buckshot Roulette... ` +
        `${formatMB(downloadedBytes)} / ` +
        `${formatMB(EXPECTED_TOTAL)} MB`
    );

    return buffer;
}

async function mergeFiles(file, start, end, expectedSize, mime) {
    const chunks = [];
    let size = 0;

    for (let i = start; i <= end; i++) {
        const buffer = await downloadPart(
            `${file}.part${i}`
        );

        chunks.push(buffer);
        size += buffer.byteLength;
    }

    if (size !== expectedSize) {
        throw new Error(
            `${file} size mismatch: got ${size}, expected ${expectedSize}`
        );
    }

    const blob = new Blob(chunks, {
        type: mime
    });

    return URL.createObjectURL(blob);
}

(async () => {
    try {
        setLoadingText(
            `Downloading Buckshot Roulette... 0 / ` +
            `${formatMB(EXPECTED_TOTAL)} MB`
        );

        const [pckUrl, wasmUrl] = await Promise.all([
            mergeFiles(
                "buckshot-roulette.pck",
                1,
                17,
                EXPECTED_PCK,
                "application/octet-stream"
            ),

            mergeFiles(
                "buckshot-roulette.wasm",
                1,
                3,
                EXPECTED_WASM,
                "application/wasm"
            )
        ]);

        setLoadingText(
            "Starting Buckshot Roulette..."
        );

        window.fetch = function(input, init) {
            let url;

            if (typeof input === "string") {
                url = input;
            } else if (input instanceof URL) {
                url = input.href;
            } else {
                url = input.url;
            }

            if (url.endsWith("buckshot-roulette.pck")) {
                return originalFetch(pckUrl, init);
            }

            if (url.endsWith("buckshot-roulette.wasm")) {
                return originalFetch(wasmUrl, init);
            }

            return originalFetch(input, init);
        };

        window.godotRunStart();

    } catch (err) {
        console.error("Buckshot startup failed:", err);

        setLoadingText(
            "Buckshot failed: " +
            (err?.message || String(err))
        );
    }
})();
