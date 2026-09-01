# BBC micro:bit VS Code Web IDE

A browser-based VS Code instance, deployed as a static site to GitHub Pages,
pre-configured for BBC micro:bit development.
Go to the URL and start coding.

> **Status:** Early WIP development.

https://carlosperate.github.io/microbit-vscode/

<p align="center">
  <img src="https://raw.githubusercontent.com/carlosperate/vscode-microbit-micropython/main/assets/screenshot.png" alt="Extension screenshot" width="75%" align="center"/>
</p>

## Run locally

```sh
npm install
npm run build
npm run dev
```

Then open <http://localhost:8080/>.

Developer documentation is available in the [dev.md](dev.md) file.

## License and acknowledgements

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

This project wouldn't be possible without the following open source projects:

- [Microsoft VS Code](https://github.com/microsoft/vscode): The underlying editor (MIT).
- [Felx-B/vscode-web](https://github.com/Felx-B/vscode-web): The bootstrap patch this VS Code build adapts (MIT).
- [Open VSX](https://open-vsx.org/): The VS Code extension marketplace this build uses.
