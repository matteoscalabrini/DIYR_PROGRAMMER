// ==========================================================
// == DIYR UPLOADER CONFIGURATION                          ==
// ==========================================================
const FIRMWARE_OPTIONS = [
    {
        displayName: "Fan Firmware v0.1 [ALPHA]",
        components: [
            { displayName: "Bootloader", binaryId: "bootloader.bin", address: 0x00001000 },
            { displayName: "Partition Table", binaryId: "partitions.bin", address: 0x00008000 },
            { displayName: "Application", binaryId: "firmware.bin", address: 0x00010000 },
            { displayName: "SPIFFS", binaryId: "spiffs.bin", address: 0x00290000 }
        ]
    }
];

// ==========================================================
// == IMPORTS FROM THE LOCAL LIBRARY                        ==
// ==========================================================
import { ESPLoader, Transport } from './bundle.js';

let uiInitialized = false;

function initUploaderUI() {
    if (uiInitialized) {
        return;
    }
    uiInitialized = true;

    const connectButton = document.getElementById('connect-btn');
    const monitorButton = document.getElementById('monitor-btn');
    const outputLogContainer = document.getElementById('output-log');
    const outputLog = outputLogContainer ? outputLogContainer.querySelector('pre') : document.querySelector('#output-log pre');
    const firmwareSelect = document.getElementById('firmware-select');

    if (!connectButton || !outputLog || !firmwareSelect) {
        console.error("Fan Uploader: missing required UI elements.");
        return;
    }

    let monitorPort = null;
    let monitorReader = null;
    let monitorWriter = null;
    let monitorReadableClosed = null;
    let monitorBuffer = "";
    let monitorActive = false;
    let monitorStopCause = null;
    let monitorCleanupPromise = null;
    let monitorSessionStarted = false;
    const monitorEncoder = new TextEncoder();

    const monitorControlsAvailable = Boolean(monitorButton);
    if (!monitorControlsAvailable) {
        console.warn("Fan Uploader: monitor button not found; serial monitor disabled.");
    }

    function setMonitorButtonState(text, disabled) {
        if (!monitorControlsAvailable) {
            return;
        }
        if (typeof text === 'string') {
            monitorButton.textContent = text;
        }
        if (typeof disabled === 'boolean') {
            monitorButton.disabled = disabled;
        }
    }

    function clearLog() {
        outputLog.textContent = "> Initializing uploader...\n> Awaiting user action.\n";
    }

    function logStatus(message, options = {}) {
        const { newLine = true } = options;
        const value = typeof message === 'string' ? message : String(message);
        if (newLine) {
            const line = document.createElement('div');
            line.textContent = value;
            outputLog.appendChild(line);
        } else {
            outputLog.append(value);
        }
        const scrollTarget = outputLogContainer || outputLog;
        if (scrollTarget) {
            scrollTarget.scrollTop = scrollTarget.scrollHeight;
        }
    }

    async function fetchBinaryBlob(path, label) {
        const response = await fetch(path);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${label} (${path}): ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    }

    function bufferMonitorOutput(chunk) {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        monitorBuffer += text;
        const lines = monitorBuffer.split(/\r?\n/);
        monitorBuffer = lines.pop() ?? "";
        lines.forEach((line) => {
            if (line.length === 0) {
                return;
            }
            logStatus(`> MONITOR: ${line}`);
        });
    }

    async function sendMonitorData(data) {
        if (!monitorWriter || !monitorActive) {
            return;
        }
        try {
            await monitorWriter.write(monitorEncoder.encode(data));
        } catch (error) {
            logStatus(`> MONITOR FAIL: ${error.message}`);
        }
    }

    function handleMonitorKeydown(event) {
        if (!monitorActive || !monitorWriter) {
            return;
        }
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        let payload = null;
        switch (event.key) {
            case 'Enter':
                payload = '\r';
                break;
            case 'Backspace':
                payload = '\x08';
                break;
            case 'Tab':
                payload = '\t';
                break;
            case 'Escape':
                payload = '\x1b';
                break;
            default:
                if (event.key.length === 1) {
                    payload = event.key;
                }
        }
        if (payload) {
            event.preventDefault();
            sendMonitorData(payload);
        }
    }

    async function cleanupMonitorResources() {
        if (monitorCleanupPromise) {
            return monitorCleanupPromise;
        }
        monitorCleanupPromise = (async () => {
            if (monitorReader) {
                try {
                    monitorReader.releaseLock();
                } catch (_err) {
                    // Ignore release errors.
                }
                monitorReader = null;
            }
            if (monitorWriter) {
                try {
                    monitorWriter.releaseLock();
                } catch (_err) {
                    // Ignore release errors.
                }
                monitorWriter = null;
            }
            if (monitorReadableClosed) {
                try {
                    await monitorReadableClosed;
                } catch (_err) {
                    // Swallow stream close errors.
                }
                monitorReadableClosed = null;
            }
            if (monitorPort) {
                try {
                    await monitorPort.close();
                } catch (_err) {
                    // Port may already be closed.
                }
                monitorPort = null;
            }
            if (monitorBuffer) {
                logStatus(`> MONITOR: ${monitorBuffer}`);
                monitorBuffer = "";
            }
            setMonitorButtonState('START MONITOR', false);
            if (monitorSessionStarted) {
                switch (monitorStopCause) {
                    case 'user':
                        logStatus(`> MONITOR: stopped.`);
                        break;
                    case 'flash':
                        // Silence - flashing log already mentions pause.
                        break;
                    case 'error':
                        logStatus(`> MONITOR: stopped (serial error).`);
                        break;
                    case 'device':
                        logStatus(`> MONITOR: device disconnected.`);
                        break;
                    default:
                        logStatus(`> MONITOR: ended.`);
                }
            }
            monitorStopCause = null;
            monitorActive = false;
            monitorSessionStarted = false;
        })();
        try {
            await monitorCleanupPromise;
        } finally {
            monitorCleanupPromise = null;
        }
    }

    async function monitorReadLoop() {
        try {
            while (monitorActive && monitorReader) {
                const { value, done } = await monitorReader.read();
                if (done) {
                    break;
                }
                if (value) {
                    bufferMonitorOutput(value);
                }
            }
        } catch (error) {
            if (monitorActive) {
                monitorStopCause = monitorStopCause ?? 'error';
                logStatus(`> MONITOR FAIL: ${error.message}`);
            }
        } finally {
            await cleanupMonitorResources();
        }
    }

    async function startSerialMonitor() {
        if (!navigator.serial) {
            logStatus(`> MONITOR ERR: WebSerial not available in this browser — please switch to Chrome, Edge, Brave, or another Chromium-based browser.`);
            return;
        }
        if (monitorActive || monitorPort) {
            await stopSerialMonitor('user');
            return;
        }
        setMonitorButtonState(undefined, true);
        monitorStopCause = null;
        try {
            logStatus(`> MONITOR: requesting serial port...`);
            monitorPort = await navigator.serial.requestPort();
            if (!monitorPort) {
                logStatus(`> MONITOR: port selection cancelled.`);
                await cleanupMonitorResources();
                return;
            }
            logStatus(`> MONITOR: opening @ 115200...`);
            await monitorPort.open({ baudRate: 115200 });
            if (typeof TextDecoderStream === 'undefined') {
                logStatus(`> MONITOR ERR: TextDecoderStream not supported in this browser.`);
                monitorStopCause = 'error';
                await cleanupMonitorResources();
                return;
            }
            const decoder = new TextDecoderStream();
            monitorReadableClosed = monitorPort.readable.pipeTo(decoder.writable);
            monitorReader = decoder.readable.getReader();
            monitorWriter = monitorPort.writable ? monitorPort.writable.getWriter() : null;
            monitorSessionStarted = true;
            monitorActive = true;
            setMonitorButtonState('STOP MONITOR', false);
            logStatus(`> MONITOR: listening @ 115200.`);
            if (monitorWriter) {
                logStatus(`> MONITOR: keyboard control enabled (press keys to send).`);
            }
            monitorReadLoop();
        } catch (error) {
            if (error && error.name === 'NotFoundError') {
                logStatus(`> MONITOR: no port selected.`);
            } else if (error && error.name === 'InvalidStateError') {
                logStatus(`> MONITOR: selected port is busy.`);
            } else if (error && error.name === 'NotReadableError') {
                logStatus(`> MONITOR: unable to read from selected port.`);
            } else if (error && error.name === 'NetworkError') {
                logStatus(`> MONITOR: access denied to serial port.`);
            } else {
                logStatus(`> MONITOR FAIL: ${error.message}`);
            }
            monitorStopCause = null;
            await cleanupMonitorResources();
        } finally {
            setMonitorButtonState(undefined, false);
        }
    }

    async function stopSerialMonitor(cause = 'user') {
        if (!monitorActive && !monitorPort) {
            return;
        }
        monitorStopCause = cause;
        monitorActive = false;
        setMonitorButtonState(undefined, true);
        if (monitorReader) {
            try {
                await monitorReader.cancel();
            } catch (_error) {
                // Ignore cancellation errors.
            }
        }
        await cleanupMonitorResources();
    }

    function populateFirmwareSelector() {
        firmwareSelect.innerHTML = '';
        FIRMWARE_OPTIONS.forEach((option, index) => {
            const opt = document.createElement('option');
            opt.value = String(index);
            opt.textContent = option.displayName;
            firmwareSelect.appendChild(opt);
        });
        if (FIRMWARE_OPTIONS.length > 0) {
            firmwareSelect.value = '0';
        }
    }

    async function uploadFirmware() {
        const selectedIndex = Number.parseInt(firmwareSelect.value, 10);
        const selectedConfig = Number.isNaN(selectedIndex)
            ? FIRMWARE_OPTIONS[0]
            : FIRMWARE_OPTIONS[selectedIndex] || FIRMWARE_OPTIONS[0];
        if (!selectedConfig) {
            logStatus(`> ERR: No firmware configuration defined.`);
            return;
        }
        let port;
        let transport;
        const monitorWasActive = monitorActive || monitorPort;
        if (monitorWasActive) {
            await stopSerialMonitor('flash');
        }

        clearLog();
        logStatus(`> ACTION: CONNECT & FLASH`);
        logStatus(`> TARGET: ${selectedConfig ? selectedConfig.displayName : 'unknown'}`);
        if (monitorWasActive) {
            logStatus(`> NOTE: Serial monitor paused for flashing.`);
        }

        if (!navigator.serial) {
            logStatus(`> ERR: WebSerial not available in this browser — please switch to Chrome, Edge, Brave, or another Chromium-based browser.`);
            return;
        }

        try {
            logStatus(`> Requesting serial port...`);
            port = await navigator.serial.requestPort();
            transport = new Transport(port);

            const terminalAdapter = {
                clean: () => {},
                write: (data) => logStatus(data, { newLine: false }),
                writeLine: (data) => logStatus(data)
            };

            logStatus(`> Connecting to chip...`);
            const loader = new ESPLoader({
                transport: transport,
                baudRate: 115200,
                terminal: terminalAdapter
            });

            await loader.connect();
            const chipName = loader.chip && loader.chip.CHIP_NAME ? loader.chip.CHIP_NAME : "unknown";
            logStatus(`> Detected chip: ${chipName}`);

            logStatus(`> Preparing flasher stub...`);
            await loader.runStub();
            logStatus(`> Stub active.`);

            if (!selectedConfig || !Array.isArray(selectedConfig.components) || selectedConfig.components.length === 0) {
                throw new Error(`No component configuration found for ${selectedConfig ? selectedConfig.displayName : 'selected firmware'}`);
            }

            const filesToFlash = [];
            for (const component of selectedConfig.components) {
                logStatus(`> Fetching ${component.displayName} (${component.binaryId})...`);
                const data = await fetchBinaryBlob(component.binaryId, component.displayName);
                const dataString = loader.ui8ToBstr(data);
                filesToFlash.push({
                    label: component.displayName,
                    path: component.binaryId,
                    address: component.address,
                    byteLength: data.byteLength,
                    dataString
                });
                logStatus(`> Prepared ${component.displayName} @ 0x${component.address.toString(16).padStart(6, '0')} (${data.byteLength} bytes).`);
            }

            const totalBytes = filesToFlash.reduce((sum, file) => sum + file.byteLength, 0);
            const fileProgress = filesToFlash.map(() => 0);
            let lastOverallPercent = -1;

            logStatus(`> Writing image set (${totalBytes.toLocaleString()} bytes total)...`);
            await loader.writeFlash({
                fileArray: filesToFlash.map((file) => ({
                    data: file.dataString,
                    address: file.address
                })),
                flashSize: "keep",
                flashMode: "keep",
                flashFreq: "keep",
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, totalForFile) => {
                    if (typeof fileProgress[fileIndex] === 'number') {
                        const fileInfo = filesToFlash[fileIndex];
                        const safeTotal = typeof totalForFile === 'number' && totalForFile > 0
                            ? totalForFile
                            : fileInfo ? fileInfo.byteLength : 0;
                        const safeWritten = typeof written === 'number' && written >= 0 ? written : 0;
                        fileProgress[fileIndex] = Math.min(safeWritten, safeTotal || safeWritten);
                    }
                    const bytesWritten = fileProgress.reduce((sum, value) => sum + value, 0);
                    const percent = totalBytes ? Math.floor((bytesWritten / totalBytes) * 100) : 100;
                    if (percent !== lastOverallPercent) {
                        lastOverallPercent = percent;
                        logStatus(`> PROGRESS: ${percent}%`);
                    }
                }
            });

            logStatus(`> Resetting device...`);
            await loader.after("hard_reset");

            const successLine = document.createElement('span');
            successLine.textContent = '> SUCCESS: Flash complete. Fan rebooting.';
            successLine.style.color = '#ffeb3b';
            successLine.style.fontWeight = '700';
            successLine.style.display = 'block';
            outputLog.appendChild(successLine);
            const scrollTarget = outputLogContainer || outputLog;
            if (scrollTarget) {
                scrollTarget.scrollTop = scrollTarget.scrollHeight;
            }
        } catch (error) {
            logStatus(`> FAIL: ${error.message}`);
        } finally {
            if (transport) {
                logStatus(`> Closing port.`);
                try {
                    await transport.disconnect();
                } catch (closeError) {
                    logStatus(`> WARN: ${closeError.message}`);
                }
            } else if (port) {
                logStatus(`> Closing port.`);
                try {
                    await port.close();
                } catch (closeError) {
                    logStatus(`> WARN: ${closeError.message}`);
                }
            }
        }
    }

    document.addEventListener('keydown', handleMonitorKeydown);

    if (monitorControlsAvailable) {
        monitorButton.addEventListener('click', async () => {
            try {
                if (monitorActive || monitorPort) {
                    await stopSerialMonitor('user');
                } else {
                    await startSerialMonitor();
                }
            } catch (error) {
                logStatus(`> MONITOR FAIL: ${error.message}`);
            }
        });
    }

    connectButton.addEventListener('click', uploadFirmware);
    populateFirmwareSelector();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUploaderUI);
} else {
    initUploaderUI();
}
