import { stat } from "node:fs/promises";
import type { Task } from "../types/index.ts";

const GIT_TIMEOUT_MS = 8_000;
const GIT_CONCURRENCY = 8;
const FIELD_SEPARATOR = "\u001f";
const DEFAULT_BASE = "origin/main";
const FALLBACK_BASE = "main";

export interface ParsedWorktree {
	path: string;
	head?: string;
	/** Short branch name (refs/heads/ stripped); absent for a detached or bare worktree. */
	branch?: string;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	prunable: boolean;
}

export interface LinkedTask {
	id: string;
	title: string;
	status: string;
}

export type LinkableTask = Pick<
	Task,
	"id" | "title" | "status" | "workBranch" | "description" | "implementationPlan" | "implementationNotes" | "rawContent"
>;

interface CommitSummary {
	headSha: string;
	lastCommitSubject: string;
	lastCommitDate: string;
}

interface BaseComparison {
	ahead: number | null;
	behind: number | null;
	mergedIntoBase: boolean | null;
	mergedBy: "ancestor" | "equivalent" | null;
	/** HEAD is exactly the base commit: nothing was ever committed on top of it. */
	atBase: boolean;
}

export interface WorktreeEntry extends CommitSummary, BaseComparison {
	path: string;
	branch: string | null;
	detached: boolean;
	isMain: boolean;
	locked: boolean;
	/** The directory is gone or git marks it prunable. */
	missing: boolean;
	dirtyCount: number | null;
	/** Merged into base, nothing uncommitted and not just the base itself: nothing would be lost by cleaning up. */
	safeToClean: boolean;
	linkedTasks: LinkedTask[];
}

export interface BranchEntry extends CommitSummary, BaseComparison {
	branch: string;
	safeToClean: boolean;
	linkedTasks: LinkedTask[];
}

export interface WorktreesReport {
	configured: true;
	repoRoot: string;
	/** The ref actually compared against; null when neither the configured base nor `main` exists. */
	base: string | null;
	generatedAt: string;
	worktrees: WorktreeEntry[];
	branches: BranchEntry[];
}

export interface WorktreesNotConfigured {
	configured: false;
	message: string;
}

/** Parses `git worktree list --porcelain` output. Pure: no git or filesystem access. */
export function parseWorktreeList(output: string): ParsedWorktree[] {
	const worktrees: ParsedWorktree[] = [];
	let current: ParsedWorktree | null = null;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (line === "") {
			if (current) worktrees.push(current);
			current = null;
			continue;
		}
		const spaceIndex = line.indexOf(" ");
		const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
		const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);
		if (key === "worktree") {
			if (current) worktrees.push(current);
			current = { path: value, detached: false, bare: false, locked: false, prunable: false };
			continue;
		}
		if (!current) continue;
		switch (key) {
			case "HEAD":
				current.head = value;
				break;
			case "branch":
				current.branch = value.replace(/^refs\/heads\//, "");
				break;
			case "detached":
				current.detached = true;
				break;
			case "bare":
				current.bare = true;
				break;
			case "locked":
				current.locked = true;
				break;
			case "prunable":
				current.prunable = true;
				break;
		}
	}
	if (current) worktrees.push(current);
	return worktrees;
}

function isNameChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9._/-]/.test(char);
}

/** True when `needle` occurs in `text` as a whole token (not inside a longer branch name or path). */
function containsToken(text: string, needle: string): boolean {
	if (!needle) return false;
	let index = text.indexOf(needle);
	while (index !== -1) {
		if (!isNameChar(text[index - 1]) && !isNameChar(text[index + needle.length])) return true;
		index = text.indexOf(needle, index + 1);
	}
	return false;
}

/**
 * Tasks tied to a branch or worktree. A task's own `work_branch` is authoritative; a task without
 * one is linked when its text names the exact branch or the worktree path. `ignoreTextForBranch`
 * stops the base branch (for example `main`) from matching every task that mentions it.
 */
export function findLinkedTasks(
	tasks: readonly LinkableTask[],
	target: { branch?: string | null; path?: string; ignoreTextForBranch?: boolean },
): LinkedTask[] {
	const linked: LinkedTask[] = [];
	for (const task of tasks) {
		const workBranch = task.workBranch?.trim();
		let match = false;
		if (workBranch) {
			match = Boolean(target.branch) && workBranch === target.branch;
		} else {
			const text = task.rawContent ?? [task.description, task.implementationPlan, task.implementationNotes].join("\n");
			match =
				(Boolean(target.branch) && !target.ignoreTextForBranch && containsToken(text, target.branch as string)) ||
				(Boolean(target.path) && containsToken(text, target.path as string));
		}
		if (match) linked.push({ id: task.id, title: task.title, status: task.status });
	}
	return linked;
}

class GitCommandError extends Error {
	constructor(
		message: string,
		readonly exitCode: number | null,
	) {
		super(message);
	}
}

async function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
	const subprocess = Bun.spawn(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as Record<string, string>,
	});
	const timer = setTimeout(() => {
		try {
			subprocess.kill("SIGKILL");
		} catch {}
	}, timeoutMs);
	timer.unref();
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			subprocess.exited,
			new Response(subprocess.stdout).text(),
			new Response(subprocess.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new GitCommandError(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`, exitCode);
		}
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
	try {
		return await runGit(cwd, args);
	} catch {
		return null;
	}
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveBase(repoRoot: string, requested: string): Promise<string | null> {
	for (const candidate of [...new Set([requested, FALLBACK_BASE])]) {
		if ((await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) !== null) {
			return candidate;
		}
	}
	return null;
}

async function compareToBase(repoRoot: string, base: string | null, sha: string): Promise<BaseComparison> {
	if (!base || !sha) return { ahead: null, behind: null, mergedIntoBase: null, mergedBy: null, atBase: false };
	const counts = await tryGit(repoRoot, ["rev-list", "--left-right", "--count", `${base}...${sha}`]);
	const [behindText, aheadText] = (counts ?? "").trim().split(/\s+/);
	const behind = counts === null ? null : Number.parseInt(behindText ?? "", 10);
	const ahead = counts === null ? null : Number.parseInt(aheadText ?? "", 10);
	if (ahead === null || behind === null || Number.isNaN(ahead) || Number.isNaN(behind)) {
		return { ahead: null, behind: null, mergedIntoBase: null, mergedBy: null, atBase: false };
	}
	const atBase = ahead === 0 && behind === 0;
	if (ahead === 0) return { ahead, behind, mergedIntoBase: true, mergedBy: "ancestor", atBase };
	// Squash or rebase merges leave the branch commits unreachable from base, but every patch
	// still has an equivalent there: `git cherry` marks those "-" and the unmerged ones "+".
	const cherry = await tryGit(repoRoot, ["cherry", base, sha]);
	const equivalent = cherry !== null && !cherry.split("\n").some((line) => line.startsWith("+"));
	return { ahead, behind, mergedIntoBase: equivalent, mergedBy: equivalent ? "equivalent" : null, atBase };
}

async function readCommit(repoRoot: string, sha: string): Promise<CommitSummary> {
	const output = sha
		? await tryGit(repoRoot, ["log", "-1", `--format=%H${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%s`, sha])
		: null;
	const [headSha = sha, lastCommitDate = "", ...subject] = (output ?? "").trim().split(FIELD_SEPARATOR);
	return { headSha, lastCommitDate, lastCommitSubject: subject.join(FIELD_SEPARATOR) };
}

/**
 * Resolves the git repository to inspect. `hint` is any path inside it; returns null when the
 * path is not inside a git work tree.
 */
export async function resolveWorktreesRepo(hint: string): Promise<string | null> {
	if (!(await pathExists(hint))) return null;
	const inside = await tryGit(hint, ["rev-parse", "--is-inside-work-tree"]);
	if (inside?.trim() !== "true") return null;
	const root = await tryGit(hint, ["rev-parse", "--show-toplevel"]);
	return root?.trim() || null;
}

export async function buildWorktreesReport(options: {
	repoHint: string;
	base?: string;
	tasks: readonly LinkableTask[];
}): Promise<WorktreesReport | WorktreesNotConfigured> {
	const repoHint = await resolveWorktreesRepo(options.repoHint);
	if (!repoHint) {
		return { configured: false, message: `Not a git repository: ${options.repoHint}` };
	}
	const listOutput = await runGit(repoHint, ["worktree", "list", "--porcelain"]);
	const parsed = parseWorktreeList(listOutput);
	const repoRoot = parsed[0]?.path ?? repoHint;
	const base = await resolveBase(repoRoot, options.base?.trim() || DEFAULT_BASE);
	const baseShortName = base?.replace(/^origin\//, "") ?? FALLBACK_BASE;

	const worktrees = await mapLimit(parsed, GIT_CONCURRENCY, async (worktree, index): Promise<WorktreeEntry> => {
		const exists = !worktree.prunable && (await pathExists(worktree.path));
		const sha = worktree.head ?? "";
		const [commit, comparison, dirty] = await Promise.all([
			readCommit(repoRoot, sha),
			compareToBase(repoRoot, base, sha),
			exists && !worktree.bare ? tryGit(worktree.path, ["status", "--porcelain"]) : Promise.resolve(null),
		]);
		const dirtyCount = dirty === null ? null : dirty.split("\n").filter((line) => line.trim() !== "").length;
		const isMain = index === 0;
		return {
			path: worktree.path,
			branch: worktree.branch ?? null,
			detached: worktree.detached,
			isMain,
			locked: worktree.locked,
			missing: !exists,
			dirtyCount,
			...commit,
			...comparison,
			safeToClean:
				!isMain &&
				exists &&
				dirtyCount === 0 &&
				comparison.mergedIntoBase === true &&
				!comparison.atBase &&
				worktree.branch !== baseShortName,
			linkedTasks: findLinkedTasks(options.tasks, {
				branch: worktree.branch,
				path: worktree.path,
				ignoreTextForBranch: worktree.branch === baseShortName,
			}),
		};
	});

	const checkedOut = new Set(parsed.map((worktree) => worktree.branch).filter(Boolean));
	const refs = await tryGit(repoRoot, [
		"for-each-ref",
		"refs/heads",
		`--format=%(refname:short)${FIELD_SEPARATOR}%(objectname)`,
	]);
	const loose = (refs ?? "")
		.split("\n")
		.map((line) => line.split(FIELD_SEPARATOR))
		.filter((parts): parts is [string, string] => Boolean(parts[0]) && Boolean(parts[1]))
		.filter(([name]) => !checkedOut.has(name));
	const branches = await mapLimit(loose, GIT_CONCURRENCY, async ([name, sha]): Promise<BranchEntry> => {
		const [commit, comparison] = await Promise.all([readCommit(repoRoot, sha), compareToBase(repoRoot, base, sha)]);
		return {
			branch: name,
			...commit,
			...comparison,
			safeToClean: comparison.mergedIntoBase === true && !comparison.atBase && name !== baseShortName,
			linkedTasks: findLinkedTasks(options.tasks, { branch: name, ignoreTextForBranch: name === baseShortName }),
		};
	});
	branches.sort((a, b) => b.lastCommitDate.localeCompare(a.lastCommitDate));

	return { configured: true, repoRoot, base, generatedAt: new Date().toISOString(), worktrees, branches };
}
