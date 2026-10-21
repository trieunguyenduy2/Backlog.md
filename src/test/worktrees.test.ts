import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
	buildWorktreesReport,
	findLinkedTasks,
	type LinkableTask,
	parseWorktreeList,
	type WorktreesReport,
} from "../core/worktrees.ts";
import { safeCleanup } from "./test-utils.ts";

describe("parseWorktreeList", () => {
	it("parses branch, detached, bare, locked and prunable entries", () => {
		const output = [
			"worktree /repo",
			"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"branch refs/heads/main",
			"",
			"worktree /repo-wt/feat a",
			"HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"branch refs/heads/feat/a",
			"locked reason text",
			"",
			"worktree /repo-wt/detached",
			"HEAD cccccccccccccccccccccccccccccccccccccccc",
			"detached",
			"",
			"worktree /repo-wt/gone",
			"HEAD dddddddddddddddddddddddddddddddddddddddd",
			"branch refs/heads/gone",
			"prunable gitdir file points to non-existent location",
			"",
			"worktree /bare.git",
			"bare",
			"",
		].join("\n");
		expect(parseWorktreeList(output)).toEqual([
			{
				path: "/repo",
				head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				branch: "main",
				detached: false,
				bare: false,
				locked: false,
				prunable: false,
			},
			{
				path: "/repo-wt/feat a",
				head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				branch: "feat/a",
				detached: false,
				bare: false,
				locked: true,
				prunable: false,
			},
			{
				path: "/repo-wt/detached",
				head: "cccccccccccccccccccccccccccccccccccccccc",
				detached: true,
				bare: false,
				locked: false,
				prunable: false,
			},
			{
				path: "/repo-wt/gone",
				head: "dddddddddddddddddddddddddddddddddddddddd",
				branch: "gone",
				detached: false,
				bare: false,
				locked: false,
				prunable: true,
			},
			{ path: "/bare.git", detached: false, bare: true, locked: false, prunable: false },
		]);
	});

	it("returns nothing for empty output", () => {
		expect(parseWorktreeList("")).toEqual([]);
	});
});

describe("findLinkedTasks", () => {
	const task = (id: string, extra: Partial<LinkableTask> = {}): LinkableTask => ({
		id,
		title: `Title ${id}`,
		status: "To Do",
		...extra,
	});

	it("links by work_branch, which wins over text mentions", () => {
		const tasks = [
			task("TASK-1", { workBranch: "feat/a" }),
			task("TASK-2", { workBranch: "feat/b", rawContent: "also touches feat/a" }),
		];
		expect(findLinkedTasks(tasks, { branch: "feat/a" }).map((t) => t.id)).toEqual(["TASK-1"]);
	});

	it("falls back to the exact branch name or worktree path in the text", () => {
		const tasks = [
			task("TASK-1", { rawContent: "Work happens on codex/portal-fix today" }),
			task("TASK-2", { rawContent: "See codex/portal-fix-2 for the sequel" }),
			task("TASK-3", { rawContent: "Checkout at /Users/x/wt/portal and test" }),
			task("TASK-4", { rawContent: "unrelated" }),
		];
		expect(findLinkedTasks(tasks, { branch: "codex/portal-fix" }).map((t) => t.id)).toEqual(["TASK-1"]);
		expect(findLinkedTasks(tasks, { branch: null, path: "/Users/x/wt/portal" }).map((t) => t.id)).toEqual(["TASK-3"]);
	});

	it("does not match text for the base branch, and returns id, title and status only", () => {
		const tasks = [task("TASK-1", { rawContent: "merge to main", status: "Done" })];
		expect(findLinkedTasks(tasks, { branch: "main", ignoreTextForBranch: true })).toEqual([]);
		expect(findLinkedTasks(tasks, { branch: "x", path: "merge" })).toEqual([
			{ id: "TASK-1", title: "Title TASK-1", status: "Done" },
		]);
	});
});

describe("buildWorktreesReport", () => {
	let root: string;
	let repo: string;

	const git = async (cwd: string, ...args: string[]) =>
		(
			await $`git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false ${args}`.cwd(cwd).quiet()
		).stdout
			.toString()
			.trim();

	beforeEach(async () => {
		// Outside the checkout: a temp dir under the project would sit inside its git repo.
		root = await realpath(await mkdtemp(join(tmpdir(), "worktrees-report-")));
		repo = join(root, "repo");
		await mkdir(repo);
		await git(repo, "init", "-b", "main");
		await writeFile(join(repo, "a.txt"), "a\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-m", "initial");
	});

	afterEach(async () => {
		await safeCleanup(root);
	});

	it("reports two worktrees and one extra branch with links, divergence and merge state", async () => {
		// feat/merged: committed and merged into main with a merge commit, worktree stays clean.
		const mergedPath = join(root, "wt-merged");
		await git(repo, "worktree", "add", "-b", "feat/merged", mergedPath);
		await writeFile(join(mergedPath, "m.txt"), "m\n");
		await git(mergedPath, "add", ".");
		await git(mergedPath, "commit", "-m", "merged work");
		await git(repo, "merge", "--no-ff", "-m", "merge feat/merged", "feat/merged");

		// feat/active: one commit ahead, plus an uncommitted file.
		const activePath = join(root, "wt-active");
		await git(repo, "worktree", "add", "-b", "feat/active", activePath);
		await writeFile(join(activePath, "x.txt"), "x\n");
		await git(activePath, "add", ".");
		await git(activePath, "commit", "-m", "active work");
		await writeFile(join(activePath, "dirty.txt"), "dirty\n");

		// feat/loose: no worktree, one commit ahead.
		await git(repo, "branch", "feat/loose");
		await git(repo, "checkout", "-q", "feat/loose");
		await writeFile(join(repo, "l.txt"), "l\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-m", "loose work");
		await git(repo, "checkout", "-q", "main");

		const tasks: LinkableTask[] = [
			{ id: "TASK-1", title: "Active feature", status: "In Progress", workBranch: "feat/active" },
			{ id: "TASK-2", title: "Loose note", status: "To Do", rawContent: "idea lives on feat/loose" },
			{ id: "TASK-3", title: "By path", status: "Done", rawContent: `worktree ${mergedPath}` },
		];

		const report = (await buildWorktreesReport({ repoHint: activePath, tasks })) as WorktreesReport;
		expect(report.configured).toBe(true);
		expect(report.repoRoot).toBe(repo);
		expect(report.base).toBe("main");

		expect(report.worktrees.map((w) => w.branch).sort()).toEqual(["feat/active", "feat/merged", "main"]);
		const main = report.worktrees.find((w) => w.branch === "main");
		expect(main?.isMain).toBe(true);
		expect(main?.safeToClean).toBe(false);

		const active = report.worktrees.find((w) => w.branch === "feat/active");
		expect(active).toMatchObject({ ahead: 1, behind: 0, mergedIntoBase: false, dirtyCount: 1, missing: false });
		expect(active?.safeToClean).toBe(false);
		expect(active?.lastCommitSubject).toBe("active work");
		expect(active?.linkedTasks.map((t) => t.id)).toEqual(["TASK-1"]);

		const merged = report.worktrees.find((w) => w.branch === "feat/merged");
		expect(merged).toMatchObject({ ahead: 0, behind: 1, mergedIntoBase: true, dirtyCount: 0, safeToClean: true });
		expect(merged?.linkedTasks.map((t) => t.id)).toEqual(["TASK-3"]);

		expect(report.branches.map((b) => b.branch)).toEqual(["feat/loose"]);
		expect(report.branches[0]).toMatchObject({ ahead: 1, behind: 0, mergedIntoBase: false, safeToClean: false });
		expect(report.branches[0]?.linkedTasks.map((t) => t.id)).toEqual(["TASK-2"]);
	});

	it("flags a worktree whose directory was deleted and a squash-style equivalent merge", async () => {
		const gonePath = join(root, "wt-gone");
		await git(repo, "worktree", "add", "-b", "feat/gone", gonePath);
		await $`rm -rf ${gonePath}`.quiet();

		// Equivalent patch already on main (cherry-picked), so the branch counts as merged.
		await git(repo, "branch", "feat/picked");
		await git(repo, "checkout", "-q", "feat/picked");
		await writeFile(join(repo, "p.txt"), "p\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-m", "picked work");
		const pickedSha = await git(repo, "rev-parse", "HEAD");
		await git(repo, "checkout", "-q", "main");
		await writeFile(join(repo, "other.txt"), "o\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-m", "diverge main");
		await git(repo, "cherry-pick", pickedSha);

		const report = (await buildWorktreesReport({ repoHint: repo, tasks: [] })) as WorktreesReport;
		const gone = report.worktrees.find((w) => w.branch === "feat/gone");
		expect(gone?.missing).toBe(true);
		expect(gone?.dirtyCount).toBeNull();
		expect(gone?.safeToClean).toBe(false);
		const picked = report.branches.find((b) => b.branch === "feat/picked");
		expect(picked).toMatchObject({ mergedIntoBase: true, mergedBy: "equivalent", safeToClean: true });
	});

	it("falls back to main when the configured base is missing and handles non-git paths", async () => {
		const report = (await buildWorktreesReport({ repoHint: repo, base: "origin/main", tasks: [] })) as WorktreesReport;
		expect(report.base).toBe("main");
		const notRepo = join(root, "plain");
		await mkdir(notRepo);
		const result = await buildWorktreesReport({ repoHint: notRepo, tasks: [] });
		expect(result.configured).toBe(false);
	});

	it("lists about ten worktrees and a hundred branches quickly", async () => {
		for (let i = 0; i < 10; i++) {
			await git(repo, "worktree", "add", "-b", `wt/${i}`, join(root, `wt-${i}`));
		}
		const names = Array.from({ length: 100 }, (_, i) => `bulk/${i}`);
		const head = await git(repo, "rev-parse", "HEAD");
		for (const name of names) await git(repo, "update-ref", `refs/heads/${name}`, head);
		const started = performance.now();
		const report = (await buildWorktreesReport({ repoHint: repo, tasks: [] })) as WorktreesReport;
		const elapsed = performance.now() - started;
		expect(report.worktrees).toHaveLength(11);
		expect(report.branches).toHaveLength(100);
		expect(elapsed).toBeLessThan(5_000);
	});
});
