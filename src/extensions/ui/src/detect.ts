/**
 * Works out whether the workspace holds a MicroPython or a C++ program, from a
 * directory walk alone. Pure: the caller supplies the reader and decides what to
 * do with an undecided answer.
 */

export type Language = 'micropython' | 'cpp';

export interface Entry {
	name: string;
	isDirectory: boolean;
}

/** Reads one directory, addressed in segments below the workspace folder. */
export type ReadDirectory = (segments: string[]) => PromiseLike<Entry[]>;

export interface Signals {
	pythonAtProjectRoot: boolean;
	/** `'unknown'` when the scan stopped before it could rule C++ out. */
	cppSource: boolean | 'unknown';
	/** `languageId` of the focused editor, when one is open. */
	activeLanguageId?: string;
}

/** What the compiler takes. Headers alone say nothing: any project may carry them. */
const CPP_SOURCE = /\.(cpp|cc|cxx)$/i;
const PYTHON = /\.py$/i;

// Vendored CODAL and build output are full of C++ that is nobody's program.
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'build', 'libraries']);

const BY_LANGUAGE_ID: Record<string, Language> = { python: 'micropython', cpp: 'cpp', c: 'cpp' };

export interface ScanLimits {
	maxDepth: number;
	maxEntries: number;
}

const DEFAULT_LIMITS: ScanLimits = { maxDepth: 4, maxEntries: 500 };

/**
 * Undefined means undecided, which is the caller's cue to ask. An unknown C++
 * answer settles nothing on its own: it neither finds C++ nor rules it out.
 */
export function detectLanguage(signals: Signals): Language | undefined {
	if (!signals.pythonAtProjectRoot) return signals.cppSource === true ? 'cpp' : undefined;
	if (signals.cppSource === false) return 'micropython';

	// The file being edited is the only honest tiebreak: a workspace holding both
	// says nothing about which one the user means to flash.
	return signals.activeLanguageId ? BY_LANGUAGE_ID[signals.activeLanguageId] : undefined;
}

/**
 * `projectSegments` says where the Python lives, never that the project is
 * MicroPython.
 */
export async function scanSignals(
	readDirectory: ReadDirectory,
	projectSegments: string[],
	limits: ScanLimits = DEFAULT_LIMITS
): Promise<Omit<Signals, 'activeLanguageId'>> {
	// Independent: a shared walk let the C++ early exit decide whether Python was ever checked.
	const [pythonAtProjectRoot, cppSource] = await Promise.all([
		hasPython(readDirectory, projectSegments),
		hasCppSource(readDirectory, limits),
	]);
	return { pythonAtProjectRoot, cppSource };
}

/** One directory, never a walk: the board's filesystem is flat, so nothing below it is flashed. */
async function hasPython(readDirectory: ReadDirectory, projectSegments: string[]): Promise<boolean> {
	try {
		return (await readDirectory(projectSegments)).some((entry) => !entry.isDirectory && PYTHON.test(entry.name));
	} catch {
		return false; // An unreadable folder is one we cannot judge, not a failed scan.
	}
}

/**
 * Depth-first and bounded, stopping at the first source found. The budget is
 * shared by the whole walk, so exhausting it leaves the tree half searched and
 * finding nothing proves nothing. The depth limit is not truncation in that
 * sense: it prunes branches too deep to hold the program being flashed.
 */
async function hasCppSource(readDirectory: ReadDirectory, limits: ScanLimits): Promise<boolean | 'unknown'> {
	let budget = limits.maxEntries;
	let truncated = false;

	const walk = async (segments: string[]): Promise<boolean> => {
		if (segments.length > limits.maxDepth) return false;
		if (budget <= 0) {
			truncated = true;
			return false;
		}

		let entries: Entry[];
		try {
			entries = await readDirectory(segments);
		} catch {
			return false;
		}

		for (const entry of entries) {
			if (budget-- <= 0) {
				truncated = true;
				return false;
			}
			if (entry.isDirectory) {
				if (!SKIP_DIRECTORIES.has(entry.name) && (await walk([...segments, entry.name]))) return true;
				continue;
			}
			if (CPP_SOURCE.test(entry.name)) return true;
		}
		return false;
	};

	if (await walk([])) return true;
	return truncated ? 'unknown' : false;
}
