import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { FileSystem } from "../file-system/operations.ts";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
import { BacklogServer } from "../server/index.ts";
import type { Task } from "../types/index.ts";
import { getTestCliPath } from "./test-cli.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

const CLI_PATH = getTestCliPath();

const baseTask: Task = {
	id: "task-1",
	title: "Branch task",
	status: "To Do",
	assignee: [],
	createdDate: "2026-01-01 10:00",
	labels: [],
	dependencies: [],
};

describe("task work_branch field", () => {
	it("round-trips through the serializer and parser", () => {
		const content = serializeTask({ ...baseTask, workBranch: "feat/zalo-bot" });
		expect(content).toContain("work_branch: feat/zalo-bot");
		expect(parseTask(content).workBranch).toBe("feat/zalo-bot");
	});

	it("is absent from frontmatter when unset", () => {
		const content = serializeTask(baseTask);
		expect(content).not.toContain("work_branch");
		expect(parseTask(content).workBranch).toBeUndefined();
	});

	describe("CLI and server", () => {
		let testDir: string;
		let core: Core;

		beforeEach(async () => {
			testDir = createUniqueTestDir("test-task-work-branch");
			await mkdir(testDir, { recursive: true });
			core = new Core(testDir);
			await initializeFilesystemTestProject(core, "Work branch project");
		});

		afterEach(async () => {
			await safeCleanup(testDir);
		});

		it("creates, edits and clears the work branch via the CLI", async () => {
			const created = await $`bun ${CLI_PATH} task create "Branchy" --work-branch feat/a --plain`.cwd(testDir).quiet();
			expect(created.exitCode).toBe(0);
			expect(created.stdout.toString()).toContain("Work branch: feat/a");
			expect((await core.filesystem.loadTask("TASK-1"))?.workBranch).toBe("feat/a");

			const edited = await $`bun ${CLI_PATH} task edit TASK-1 --work-branch fix/b --plain`.cwd(testDir).quiet();
			expect(edited.stdout.toString()).toContain("Work branch: fix/b");
			expect((await core.filesystem.loadTask("TASK-1"))?.workBranch).toBe("fix/b");

			await $`bun ${CLI_PATH} task edit TASK-1 --title "Renamed"`.cwd(testDir).quiet();
			expect((await core.filesystem.loadTask("TASK-1"))?.workBranch).toBe("fix/b");

			const json = await $`bun ${CLI_PATH} task view TASK-1 --json`.cwd(testDir).quiet();
			expect(JSON.parse(json.stdout.toString()).task.workBranch).toBe("fix/b");

			const cleared = await $`bun ${CLI_PATH} task edit TASK-1 --work-branch "" --plain`.cwd(testDir).quiet();
			expect(cleared.stdout.toString()).not.toContain("Work branch:");
			expect((await core.filesystem.loadTask("TASK-1"))?.workBranch).toBeUndefined();
			const raw = await Bun.file((await core.filesystem.loadTask("TASK-1"))?.filePath ?? "").text();
			expect(raw).not.toContain("work_branch");
		});

		it("accepts workBranch on the server update endpoint", async () => {
			await $`bun ${CLI_PATH} task create "Server branchy"`.cwd(testDir).quiet();
			const server = new BacklogServer(testDir);
			try {
				const handlers = server as unknown as {
					handleUpdateTask(request: Request, taskId: string): Promise<Response>;
				};
				const update = (body: unknown) =>
					handlers.handleUpdateTask(
						new Request("http://localhost/api/tasks/TASK-1", {
							method: "PUT",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						}),
						"TASK-1",
					);
				const response = await update({ workBranch: "feat/server" });
				expect(response.status).toBe(200);
				expect(((await response.json()) as Task).workBranch).toBe("feat/server");
				expect((await new FileSystem(testDir).loadTask("TASK-1"))?.workBranch).toBe("feat/server");
				const cleared = await update({ workBranch: null });
				expect(((await cleared.json()) as Task).workBranch).toBeUndefined();
			} finally {
				await server.stop();
			}
		});
	});
});
