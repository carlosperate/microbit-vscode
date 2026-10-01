import { describe, expect, it } from 'vitest';

import { canvasSize, declaredImages, readPngSize } from '../build-scripts/render-hero.mjs';

function pngHeader(width, height) {
	const buf = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

describe('readPngSize', () => {
	it('reads the IHDR dimensions', () => {
		expect(readPngSize(pngHeader(2984, 2054))).toEqual({ width: 2984, height: 2054 });
	});

	it('rejects anything that is not a PNG', () => {
		expect(() => readPngSize(Buffer.from('<svg></svg>'.padEnd(24)))).toThrow(/PNG/);
	});
});

describe('canvasSize', () => {
	it('reads the root width and height', () => {
		const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1000" viewBox="0 0 2400 1000"><image width="5" height="5"/></svg>';
		expect(canvasSize(svg)).toEqual({ width: 2400, height: 1000 });
	});

	it('throws when the root has no size', () => {
		expect(() => canvasSize('<svg viewBox="0 0 1 1"></svg>')).toThrow(/width and height/);
	});
});

describe('declaredImages', () => {
	it('lists each image with the size the SVG declares, whatever the attribute order', () => {
		const svg = `
			<image href="a.png" width="10" height="20"/>
			<image height="40" xlink:href="b.png" width="30"/>`;
		expect(declaredImages(svg)).toEqual([
			{ href: 'a.png', width: 10, height: 20 },
			{ href: 'b.png', width: 30, height: 40 },
		]);
	});

	it('ignores inline data images', () => {
		expect(declaredImages('<image href="data:image/png;base64,AAAA" width="1" height="1"/>')).toEqual([]);
	});
});
