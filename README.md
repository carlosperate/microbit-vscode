# micro:bit Web IDE

A browser-based VS Code instance, deployable as a static site to GitHub Pages, pre-configured for micro:bit development.
No installation, no login, only open the URL and start coding.

Built on top of the [`vscode-web`](https://github.com/Felx-B/vscode-web) npm package, with extensions pulled from [Open VSX](https://open-vsx.org/) at build time.

> **Status:** Early WIP development.

## Run locally

```sh
npm install
npm run build
npm run dev
```

Then open <http://localhost:8080/>.

## License and acknowledgements

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

This project wouldn't be possible without the following open source projects:

- [Microsoft VS Code](https://github.com/microsoft/vscode): The underlying editor (MIT).
- [Felx-B/vscode-web](https://github.com/Felx-B/vscode-web): The community-maintained `vscode-web` npm package.
- [Open VSX](https://open-vsx.org/): The VS Code extension marketplace this build uses.
