import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { WorktreesNotConfigured, WorktreesReport } from "../core/worktrees.ts";
import { FileSystem } from "../file-system/operations.ts";
import { BacklogServer } from "../server/index.ts";
import { safeCleanup } from "./test-utils.ts";

describe("GET /api/worktrees", () => {
	let root: string;
	let project: string;
	let repo: string;
	let server: BacklogServer | null;
	let filesystem: FileSystem;

	const git = async (cwd: string, ...args: string[]) =>
		await $`git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false ${args}`.cwd(cwd).quiet();

	const baseConfig = {
		projectName: "Worktrees",
		statuses: ["To Do", "Done"],
		labels: [],
		milestones: [],
		dateFormat: "YYYY-MM-DD",
		remoteOperations: false,
		checkActiveBranches: false,
		autoCommit: false,
	};

	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "server-worktrees-")));
		project = join(root, "project");
		repo = join(root, "repo");
		await mkdir(project);
		await mkdir(repo);
		await git(repo, "init", "-b", "main");
		await writeFile(join(repo, "a.txt"), "a\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-m", "initial");
		await git(repo, "branch", "feat/linked");
		filesystem = new FileSystem(project);
		await filesystem.ensureBacklogStructure();
		server = null;
	});

	afterEach(async () => {
		await server?.stop();
		await safeCleanup(root);
	});

	const fetchReport = async () => {
		server = new BacklogServer(project);
		const handler = server as unknown as { handleGetWorktrees(): Promise<Response> };
		return (await (await handler.handleGetWorktrees()).json()) as WorktreesReport | WorktreesNotConfigured;
	};

	it("reports not configured when the project is not a git repo and worktrees_repo is unset", async () => {
		await filesystem.saveConfig(baseConfig);
		const report = await fetchReport();
		expect(report.configured).toBe(false);
	});

	it("lists branches linked to tasks through work_branch from worktrees_repo", async () => {
		await filesystem.saveConfig({ ...baseConfig, worktreesRepo: repo, worktreesBase: "main" });
		await filesystem.saveTask({
			id: "task-1",
			title: "Linked task",
			status: "To Do",
			assignee: [],
			createdDate: "2026-01-01 10:00",
			labels: [],
			dependencies: [],
			workBranch: "feat/linked",
		});
		const report = await fetchReport();
		if (!report.configured) throw new Error(report.message);
		expect(report.repoRoot).toBe(repo);
		expect(report.base).toBe("main");
		expect(report.worktrees.map((w) => w.branch)).toEqual(["main"]);
		expect(report.branches.map((b) => b.branch)).toEqual(["feat/linked"]);
		expect(report.branches[0]?.linkedTasks).toEqual([{ id: "TASK-1", title: "Linked task", status: "To Do" }]);
	});
});
