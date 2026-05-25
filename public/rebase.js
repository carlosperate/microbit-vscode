// Pure helper used by public/index.html to rewrite `additionalBuiltinExtensions`
// URIs before handing them to the workbench. Bare `{scheme:"http", path}`
// entries (the shape we ship in config/product.template.json) are missing an authority,
// which breaks browsers; this function injects `location.host` + protocol and
// prepends the deployed sub-path so URIs work under both root and project-page
// deploys. Loaded as a classic <script> so it must NOT use ESM syntax — tests
// evaluate this file in a sandbox; see rebase.test.mjs.
window.microbitRebase = function rebase(ext, host, protocol, basePath) {
	if ((ext.scheme === 'http' || ext.scheme === 'https') && !ext.authority) {
		return { ...ext, scheme: protocol, authority: host, path: basePath + ext.path };
	}
	return ext;
};
