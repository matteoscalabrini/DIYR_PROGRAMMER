# DIYR Fan Uploader

Web-based ESP32 flashing utility tailored for the DIYR Fan project. Serve the page locally (or from any static host that allows WebSerial), plug in the fan controller, and you can flash complete builds or talk to the device over serial directly in your browser.

## Features

- **One-click flashing** – Boots the ESP in ROM loader mode, uploads the stub, and writes all required images (bootloader, partition table, application, SPIFFS) using the bundled `esptool.js`.
- **Firmware presets** – Configure multiple firmware bundles in `app.js` (`FIRMWARE_OPTIONS`), each with its own component list and flashing offsets.
- **Live terminal** – Real-time devices logs streamed via WebSerial, with auto-scroll and an attention-grabbing success banner when flashing finishes.
- **Keyboard passthrough** – While the monitor is active, keystrokes go straight to the serial port so you can exercise firmware features that expect interactive input.
- **Hot-pluggable monitor** – Toggle monitoring without dropping connection state; the uploader pauses it automatically before flashing and restores your view afterwards.

## Project layout

```
├── app.js            Main UI/controller logic (imported as an ES module)
├── bundle.js         Packaged esptool.js bundle (ES module build)
├── bootloader.bin    ESP32 second-stage bootloader image (offset 0x1000)
├── partitions.bin    Partition table (offset 0x8000)
├── firmware.bin      Default application binary (offset 0x10000)
├── spiffs.bin        SPIFFS filesystem image (offset 0x290000)
├── index.html        Minimal UI shell
├── style.css         Retro terminal styling
└── lib/              Individual esptool.js modules (also imported by bundle)
```

## Usage

1. Open `index.html` in a Chromium-based browser (Chrome, Edge, Brave, etc.).
2. Connect the DIYR Fan controller via USB.  
   The board must enumerate as a WebSerial-compatible USB CDC device.
3. Select the firmware bundle from the dropdown and press **CONNECT & FLASH**.
   - The uploader requests the port, uploads the stub, and writes every component defined in the selected bundle.
   - Progress is shown in the terminal view; the final line turns bright yellow when flashing completes.
4. Optionally press **START MONITOR** to stream device logs and issue keyboard commands.

### Keyboard shortcuts in monitor mode

When the monitor is active (and the browser window has focus):
- Regular printable keys send the corresponding character.
- `Enter` → Carriage return (`\r`)
- `Backspace` → Backspace (`\b`)
- `Tab` → Horizontal tab (`\t`)
- `Escape` → ESC (`\x1b`)
Modifier combinations (Ctrl/Cmd/Alt) are ignored to avoid clobbering browser shortcuts.

## Customising firmware bundles

Edit the `FIRMWARE_OPTIONS` array in `app.js`:

```js
const FIRMWARE_OPTIONS = [
  {
    displayName: "Fan Firmware v1.0 [stable]",
    components: [
      { displayName: "Bootloader",  binaryId: "bootloader.bin", address: 0x00001000 },
      { displayName: "Partition",   binaryId: "partitions.bin", address: 0x00008000 },
      { displayName: "Application", binaryId: "firmware.bin",   address: 0x00010000 },
      { displayName: "SPIFFS",      binaryId: "spiffs.bin",     address: 0x00290000 }
    ]
  },
  // add more bundles here…
];
```

Each component must reference a binary accessible from the page (relative URL or absolute path) and specify the correct flash offset (in bytes). Offsets above match the PlatformIO defaults for ESP32 projects using OTA + SPIFFS partitions.

## Development notes

- The UI is intentionally static—no build step required. Make sure the browser supports WebSerial (`navigator.serial`), which currently means Chromium-derived browsers.
- `bundle.js` is the prebuilt ESM output of Espressif’s `esptool-js`. If you update to a newer release, keep `lib/` in sync in case you want to import individual helpers.
- Binary fetch is done relative to `index.html`. Adjust paths if you host assets elsewhere.
- Auto-scroll relies on the terminal container (`#output-log`) having `overflow-y: auto`.

## Troubleshooting

- **“invalid header” spam after flashing** – Ensure the bootloader image is flashed at `0x1000`. Old configs that used `0x0000` will leave the device stuck in ROM loader mode.
- **“selected port is busy” when starting monitor** – Close other tabs or apps using the same serial port. The uploader also pauses the monitor during flashing to avoid conflicts.
- **Browser can’t find WebSerial** – Switch to Chrome/Edge or enable the experimental WebSerial flag in compatible browsers. Firefox and Safari do not support it yet.

## License

This project wraps Espressif’s `esptool-js` (Apache 2.0). All custom logic in this repository is likewise provided under the Apache 2.0 license unless otherwise stated.

