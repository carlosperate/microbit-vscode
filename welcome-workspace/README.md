# Welcome to the micro:bit Web IDE

A zero-install VS Code, running entirely in your browser, pre-configured for
micro:bit development.

## Where are my files stored?

You're currently in the **`memfs://`** workspace — an in-memory scratch space.
Everything in it disappears when you reload the tab.

Three storage backends are available:

| Scheme       | Where it lives                                | Survives reload? |
| ------------ | --------------------------------------------- | ---------------- |
| `memfs://`   | RAM                                           | No               |
| `idbfs://`   | IndexedDB (this browser, this site)           | Yes              |
| `localfs://` | A real folder on your disk (Chromium browsers) | Yes              |

To switch: open the Command Palette (`Ctrl/Cmd-Shift-P`) and run
**"micro:bit: Switch Workspace Storage"**.

## Getting started

Open `main.py` next to this preview — it's a tiny MicroPython program that
scrolls a greeting on the LED matrix. Edit it, then flash it to a connected
micro:bit using the device-manager extension (look for the USB icon in the
status bar).

## Learn more

- micro:bit project: <https://microbit.org/>
- MicroPython on micro:bit: <https://microbit-micropython.readthedocs.io/>
