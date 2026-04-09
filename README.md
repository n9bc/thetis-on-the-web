# Thetis On The Web (TOTW)

![TOTW](images/Web-UI-1.png)

**Thetis On The Web (TOTW)** is a zero-install, single-file browser-based client for the Thetis SDR software. It communicates with Thetis via WebSockets using the TCI (Transceiver Control Interface) Protocol v2.0, providing full rig control, real-time IQ panadapter and waterfall displays, and two-way audio streaming — all directly in your web browser.

Built entirely with vanilla HTML, CSS, and JavaScript. No build tools, no dependencies, no installation.

---

[![Donate](https://img.shields.io/badge/Donate-PayPal-blue.svg?logo=paypal)](https://paypal.me/n9bc)
&nbsp;
[![Latest Release](https://img.shields.io/github/v/release/n9bc/thetis-on-the-web?label=Latest)](https://github.com/n9bc/thetis-on-the-web/releases/latest)

---

## ✨ Features

- **Real-Time Panadapter & Waterfall** — Hardware-accelerated Canvas rendering with client-side 4096-pt FFT and Blackman-Harris windowing for smooth, high-resolution IQ spectrum displays
- **Full Rig Control** — VFO A/B, Split, Swap, mode, filter, tune step, AF/Drive gain, NR1–4, ANF
- **Two-Way TCI Audio** — RX audio to browser speaker; TX mic from browser microphone
- **DX Cluster Integration** — Live Spothole API spots overlaid on the panadapter with click-to-tune, country flags, new-spot highlighting, and band/mode/continent filtering
- **NFL & Custom Color Themes** — 32 NFL team UI themes plus spectrum/waterfall color palettes
- **Memory Management** — Save, recall, import, and export frequency memories as JSON
- **Customizable Workspace** — Draggable, dockable, resizable panels with persistent layout
- **S-Meter & Power/SWR** — Vintage analog arc meter with LED signal bar
- **Digital Mode Markers** — FT8, FT4, WSPR, JS8, PSK31 frequency markers on the panadapter
- **Propagation Widget** — Live SFI, A/K index and band conditions from hamqsl.com
- **Audio Recording** — Record RX audio and download as WebM/Opus
- **Auto Update Check** — Notifies you in the top bar when a newer version is available on GitHub

---

## 🚀 Getting Started

### Prerequisites

1. **Thetis SDR Software** — installed and running with your OpenHPSDR hardware (ANAN, Hermes-Lite 2, etc.)
2. **TCI Server enabled** in Thetis (Setup → TCI → Enable TCI Server, default port `50001`)
3. A modern web browser — Chrome or Edge recommended

### Installation

TOTW is a single HTML file. "Installation" is just downloading and opening it:

1. Download `totw.html` from the [latest release](https://github.com/n9bc/thetis-on-the-web/releases/latest)
2. Open it in your browser
3. Enter your Thetis TCI address (e.g. `ws://127.0.0.1:50001`) and click **CONNECT**

> **TX Mic note:** Browsers require `https://` or `localhost` for microphone access. If you open the file directly from your filesystem (`file://`), TX audio will be unavailable.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` | PTT (momentary hold or toggle) |
| `↑` / `↓` | VFO step up / down |
| `Ctrl + ↑/↓` | Large VFO step (×10) |
| `Ctrl + Scroll` | Zoom in/out on panadapter |
| `Dbl-click spectrum` | Reset zoom |
| `M` | Save frequency to memory |
| `F1` – `F4` | Recall memories 1–4 |
| `D` | Toggle digital mode markers |
| `X` | Toggle DX cluster overlay |
| `P` | Toggle peak hold |
| `?` | Keyboard shortcut help |
| `Esc` | Close modals |

---

## 🛠️ Technical Notes

- **Protocol:** TCI v2.0 — binary frames with 64-byte headers for Float32 audio and IQ streams
- **FFT:** Custom Radix-2 Cooley-Tukey implementation with Blackman-Harris window, 4096-point at 192 kHz
- **Audio:** Web Audio API (`AudioContext`) — gapless Float32 stereo playback with scheduled buffering
- **Single file:** All CSS, JS, and HTML in one `totw.html` — no external dependencies

---

## 🤝 Contributors

| Callsign | Name | Role |
| :--- | :--- | :--- |
| N9BC | Brent | Project lead & idea man |
| N8SDR | Rick | Contributor |
| KC8YTK | Tim | Testing |
| VK2LAT | Murry | Testing |
| ON7OFF | Kurt | Contributor |
| — | Claude.ai Sonnet 4.6 | AI development assistant |

---

## 📝 How to Contribute

Feature requests, bug reports, and code contributions are welcome.  
Find us on the **Thetis Discord Server**.

---

## 📄 License

MIT
