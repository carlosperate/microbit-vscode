/**
 * Strip `sourceMappingURL` comments that point at an external URL (absolute
 * `http(s)://…` or protocol-relative `//host/…`).
 *
 * The vscode-web bundle ships zero `.map` files but ~47 of its JS files end
 * with `//# sourceMappingURL=https://main.vscode-cdn.net/sourcemaps/<commit>/…`.
 * That host no longer serves those paths (Azure returns 504 after ~8s), so with
 * DevTools open every one of them stalls on a dead request for a map we don't
 * ship anyway.
 *
 * Relative `sourceMappingURL` comments are preserved — some vendored deps
 * (xterm addons, applicationinsights) do ship their `.map` alongside. Only a
 * leading `//` or `http(s)://` marks a URL as external; no shipped relative map
 * begins that way.
 *
 * Both patterns are anchored to the start of a line so that `sourceMappingURL`
 * text appearing mid-line inside string/template literals (vs/loader.js builds
 * such comments at runtime) is left untouched.
 */
export function stripExternalSourceMappingUrls(source) {
	return source
		// `//# sourceMappingURL=https://…` or `=//host/…` (JS line comment)
		.replace(/^[ \t]*\/\/[#@] sourceMappingURL=(?:https?:)?\/\/\S*[ \t]*(\r?\n|$)/gm, '')
		// `/*# sourceMappingURL=https://… */` or `=//host/… */` (CSS block comment)
		.replace(/^[ \t]*\/\*[#@] sourceMappingURL=(?:https?:)?\/\/.*?\*\/[ \t]*(\r?\n|$)/gm, '');
}
