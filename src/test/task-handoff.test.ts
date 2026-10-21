import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { FileSystem } from "../file-system/operations.ts";
import { BacklogServer } from "../server/index.ts";
import type { Task } from "../types/index.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

describe("hand-off config and comment + status update", () => {
	let testDir: string;
	let filesystem: FileSystem;
	let server: BacklogServer | null;

	beforeEach(async () => {
		testDir = createUniqueTestDir("task-handoff");
		await mkdir(testDir, { recursive: true });
		await $`git init -b main`.cwd(testDir).quiet();
		filesystem = new FileSystem(testDir);
		await filesystem.ensureBacklogStructure();
		server = null;
	});

	afterEach(async () => {
		await server?.stop();
		await safeCleanup(testDir);
	});

	it("round-trips handoff and worktrees config keys, including non-ASCII and spaces", async () => {
		await filesystem.saveConfig({
			projectName: "Handoff",
			statuses: ["Chờ bạn", "Agent cần làm", "Xong"],
			labels: [],
			milestones: [],
			dateFormat: "YYYY-MM-DD",
			handoffStatus: "Agent cần làm",
			handoffLabel: "Trả lời & giao agent",
			worktreesRepo: "/tmp/my repo/ZALO CHAT",
			worktreesBase: "origin/main",
		});
		const raw = await Bun.file(filesystem.configFilePath).text();
		expect(raw).toContain('handoff_status: "Agent cần làm"');
		expect(raw).toContain('handoff_label: "Trả lời & giao agent"');
		expect(raw).toContain('worktrees_repo: "/tmp/my repo/ZALO CHAT"');
		expect(raw).toContain('worktrees_base: "origin/main"');

		const parsed = new FileSystem(testDir).parseConfig(raw);
		expect(parsed.handoffStatus).toBe("Agent cần làm");
		expect(parsed.handoffLabel).toBe("Trả lời & giao agent");
		expect(parsed.worktreesRepo).toBe("/tmp/my repo/ZALO CHAT");
		expect(parsed.worktreesBase).toBe("origin/main");
		const unset = new FileSystem(testDir).parseConfig(
			'project_name: "X"\nstatuses: ["A"]\nlabels: []\ndate_format: yyyy-mm-dd\n',
		);
		expect(unset.handoffStatus).toBeUndefined();
		expect(unset.worktreesRepo).toBeUndefined();
	});

	it("applies the comment and the status in one update and fires the status callback once", async () => {
		const callbackLog = join(testDir, "callback.log");
		await filesystem.saveConfig({
			projectName: "Handoff",
			statuses: ["Chờ bạn", "Agent cần làm", "Xong"],
			labels: [],
			milestones: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: false,
			checkActiveBranches: false,
			autoCommit: false,
			handoffStatus: "Agent cần làm",
			onStatusChange: `echo "$TASK_ID:$OLD_STATUS->$NEW_STATUS" >> "${callbackLog}"`,
		});
		server = new BacklogServer(testDir);
		const handlers = server as unknown as {
			handleCreateTask(request: Request): Promise<Response>;
			handleUpdateTask(request: Request, taskId: string): Promise<Response>;
		};
		const json = (path: string, method: string, body: unknown) =>
			new Request(`http://localhost${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const created = (await (
			await handlers.handleCreateTask(json("/api/tasks", "POST", { title: "Needs answer", status: "Chờ bạn" }))
		).json()) as Task;

		const response = await handlers.handleUpdateTask(
			json(`/api/tasks/${created.id}`, "PUT", {
				commentsAppend: ["Dùng cổng 3080"],
				commentAuthor: "@giao",
				status: "Agent cần làm",
			}),
			created.id,
		);
		expect(response.status).toBe(200);
		const updated = (await response.json()) as Task;
		expect(updated.status).toBe("Agent cần làm");
		expect(updated.comments?.map((c) => [c.body, c.author])).toEqual([["Dùng cổng 3080", "@giao"]]);

		const stored = await filesystem.loadTask(created.id);
		expect(stored?.status).toBe("Agent cần làm");
		expect(stored?.comments).toHaveLength(1);

		const lines = (await Bun.file(callbackLog).text()).trim().split("\n");
		expect(lines).toEqual([`${created.id}:Chờ bạn->Agent cần làm`]);
	});
});
