import { describe, it, expect } from 'vitest';
import { stripExternalSourceMappingUrls } from '../build-scripts/strip-sourcemap-urls.mjs';

describe('stripExternalSourceMappingUrls', () => {
	it('strips a trailing absolute sourceMappingURL comment', () => {
		const input = 'console.log(1);\n//# sourceMappingURL=https://main.vscode-cdn.net/sourcemaps/abc/core/vs/loader.js.map\n';
		expect(stripExternalSourceMappingUrls(input)).toBe('console.log(1);\n');
	});

	it('strips it even without a trailing newline', () => {
		const input = 'console.log(1);\n//# sourceMappingURL=https://example.com/a.js.map';
		expect(stripExternalSourceMappingUrls(input)).toBe('console.log(1);\n');
	});

	it('strips a protocol-relative external sourceMappingURL', () => {
		const input = 'x();\n//# sourceMappingURL=//main.vscode-cdn.net/sourcemaps/abc.js.map\n';
		expect(stripExternalSourceMappingUrls(input)).toBe('x();\n');
	});

	it('keeps relative sourceMappingURL comments (their .map may be shipped)', () => {
		const input = 'x();\n//# sourceMappingURL=addon-webgl.js.map\n';
		expect(stripExternalSourceMappingUrls(input)).toBe(input);
	});

	it('leaves sourceMappingURL text embedded mid-line inside code alone', () => {
		// vs/loader.js builds these at runtime; they are not real comments.
		const input = 'const s=`//# sourceMappingURL=https://cdn.example/x.map`;\n';
		expect(stripExternalSourceMappingUrls(input)).toBe(input);
	});

	it('handles the //@ variant and leading indentation', () => {
		const input = 'a();\n\t//@ sourceMappingURL=https://example.com/a.js.map\n b();\n';
		expect(stripExternalSourceMappingUrls(input)).toBe('a();\n b();\n');
	});

	it('strips the CSS block-comment form', () => {
		const input = '.a{color:red}\n/*# sourceMappingURL=https://example.com/a.css.map */\n';
		expect(stripExternalSourceMappingUrls(input)).toBe('.a{color:red}\n');
	});

	it('keeps the relative CSS block-comment form', () => {
		const input = '.a{color:red}\n/*# sourceMappingURL=a.css.map */\n';
		expect(stripExternalSourceMappingUrls(input)).toBe(input);
	});

	it('returns content unchanged when there is nothing to strip', () => {
		const input = 'export const a = 1;\n';
		expect(stripExternalSourceMappingUrls(input)).toBe(input);
	});

	it('is idempotent', () => {
		const input = 'y();\n//# sourceMappingURL=https://example.com/y.js.map\n';
		const once = stripExternalSourceMappingUrls(input);
		expect(stripExternalSourceMappingUrls(once)).toBe(once);
	});

	it('handles CRLF line endings', () => {
		const input = 'z();\r\n//# sourceMappingURL=https://example.com/z.js.map\r\n';
		expect(stripExternalSourceMappingUrls(input)).toBe('z();\r\n');
	});
});
