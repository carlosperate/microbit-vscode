# Welcome to the micro:bit Web IDE

A zero-install VS Code, running entirely in your browser, pre-configured for
micro:bit development.

Currently configured for MicroPython development, more features to be added
soon.

## Where are my files stored?

The default workspace uses **`memfs://`**, an in-memory scratch space.
Everything in it disappears when you reload the tab.

Three storage backends are available:

| Scheme       | Where it lives                                | Survives reload? |
| ------------ | --------------------------------------------- | ---------------- |
| `memfs://`   | RAM                                           | No               |
| `idbfs://`   | IndexedDB (this browser, this site)           | Yes              |
| `localfs://` | A real folder on your disk (Chromium browsers) | Yes              |

To switch: open the Command Palette (`Ctrl/Cmd-Shift-P` or `F1`) and run
**"micro:bit: Switch Workspace Storage"**.

## Getting started

1. The `main.py` file should be already opened next to this preview.
    - It's a small MicroPython example program.
2. Look at the status bar at the bottom of the editor and click the micro:bit
  entry with a plug icon.
3. Select the action you'd like to perform: Flash the programme, save the hex,
  or connect to the serial terminal.

![Screenshot](https://raw.githubusercontent.com/carlosperate/vscode-microbit-micropython/main/assets/screenshot.png)

## Learn more

- micro:bit project: <https://microbit.org/>
- MicroPython on micro:bit: <https://microbit-micropython.readthedocs.io/>
