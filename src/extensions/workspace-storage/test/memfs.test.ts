import { describe, it, expect, beforeEach } from 'vitest';
import { MemFS, FileNotFound, FileExists, FileIsADirectory } from '../src/memfs.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('MemFS', () => {
	let fs: MemFS;
	beforeEach(() => {
		fs = new MemFS();
	});

	it('writeFile creates a file and readFile returns its bytes', () => {
		fs.writeFile('/hello.txt', enc('hi'), { create: true, overwrite: true });
		expect(dec(fs.readFile('/hello.txt'))).toBe('hi');
	});

	it('createDirectory + writeFile inside → readDirectory lists the entry', () => {
		fs.createDirectory('/dir');
		fs.writeFile('/dir/a.txt', enc('x'), { create: true, overwrite: true });
		expect(fs.readDirectory('/dir')).toEqual([['a.txt', 'file']]);
	});

	it('rename moves a file', () => {
		fs.writeFile('/a.txt', enc('x'), { create: true, overwrite: true });
		fs.rename('/a.txt', '/b.txt', { overwrite: false });
		expect(() => fs.stat('/a.txt')).toThrow(FileNotFound);
		expect(dec(fs.readFile('/b.txt'))).toBe('x');
	});

	it('delete recursive removes a directory and its contents', () => {
		fs.createDirectory('/d');
		fs.writeFile('/d/x', enc(''), { create: true, overwrite: true });
		fs.delete('/d', { recursive: true });
		expect(() => fs.stat('/d')).toThrow(FileNotFound);
	});

	it('stat throws FileNotFound on missing', () => {
		expect(() => fs.stat('/missing')).toThrow(FileNotFound);
	});

	it('writeFile without create on missing throws FileNotFound', () => {
		expect(() => fs.writeFile('/x', enc(''), { create: false, overwrite: true })).toThrow(FileNotFound);
	});

	it('writeFile without overwrite on existing throws FileExists', () => {
		fs.writeFile('/x', enc('a'), { create: true, overwrite: true });
		expect(() => fs.writeFile('/x', enc('b'), { create: true, overwrite: false })).toThrow(FileExists);
	});

	it('readFile on a directory throws FileIsADirectory', () => {
		fs.createDirectory('/d');
		expect(() => fs.readFile('/d')).toThrow(FileIsADirectory);
	});
});
