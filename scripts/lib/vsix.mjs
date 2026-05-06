import yauzl from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const PREFIX = 'extension/';

/**
 * Unpack the `extension/` directory of a VSIX (which is a ZIP) into outDir.
 * Strips the `extension/` prefix. Entries outside `extension/` are ignored.
 */
export async function unpackVsix(zipPath, outDir) {
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });

	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
			if (err) return reject(err);
			zip.on('error', reject);
			zip.on('end', resolve);
			zip.on('entry', (entry) => {
				const name = entry.fileName;
				if (!name.startsWith(PREFIX) || name === PREFIX) {
					zip.readEntry();
					return;
				}
				const rel = name.slice(PREFIX.length);
				const dest = path.join(outDir, rel);

				if (name.endsWith('/')) {
					mkdir(dest, { recursive: true })
						.then(() => zip.readEntry())
						.catch(reject);
					return;
				}

				mkdir(path.dirname(dest), { recursive: true })
					.then(() => {
						zip.openReadStream(entry, (err, stream) => {
							if (err) return reject(err);
							const out = createWriteStream(dest);
							stream.pipe(out);
							out.on('finish', () => zip.readEntry());
							out.on('error', reject);
						});
					})
					.catch(reject);
			});
			zip.readEntry();
		});
	});
}
