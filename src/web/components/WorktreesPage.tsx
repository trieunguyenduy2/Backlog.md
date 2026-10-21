import React, { useCallback, useEffect, useState } from "react";
import type { BranchEntry, LinkedTask, WorktreeEntry, WorktreesNotConfigured, WorktreesReport } from "../../core/worktrees";
import type { Task } from "../../types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

interface WorktreesPageProps {
	tasks: Task[];
	onEditTask: (task: Task) => void;
}

const statusChipClass = (status: string) => {
	switch (status.toLowerCase()) {
		case "done":
		case "xong":
			return "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200";
		case "in progress":
		case "đang làm":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
	}
};

const relativeTime = (iso: string): string => {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.round((then - Date.now()) / 1000);
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		["year", 31_536_000],
		["month", 2_592_000],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
	}
	return formatter.format(seconds, "second");
};

const shortPath = (path: string): string => {
	const parts = path.split("/").filter(Boolean);
	return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
};

type Row = {
	key: string;
	branch: string | null;
	path?: string;
	entry: WorktreeEntry | BranchEntry;
};

const Badge: React.FC<{ tone: "green" | "amber" | "red" | "gray"; children: React.ReactNode }> = ({ tone, children }) => {
	const tones = {
		green: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
		amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
		red: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
		gray: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
	};
	return <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
};

const WorktreesPage: React.FC<WorktreesPageProps> = ({ tasks, onEditTask }) => {
	const [report, setReport] = useState<WorktreesReport | WorktreesNotConfigured | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setReport(await apiClient.fetchWorktrees());
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load worktrees");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const openTask = (linked: LinkedTask) => {
		const task = tasks.find((candidate) => candidate.id === linked.id);
		if (task) onEditTask(task);
	};

	const renderTasks = (linked: LinkedTask[]) =>
		linked.length === 0 ? (
			<span className="text-gray-400">—</span>
		) : (
			<div className="flex flex-col gap-1">
				{linked.map((task) => (
					<button
						key={task.id}
						type="button"
						onClick={() => openTask(task)}
						className="flex max-w-xs items-center gap-1.5 text-left text-xs hover:underline"
						title={`${task.id} ${task.title}`}
					>
						<span className="shrink-0 font-mono text-gray-500 dark:text-gray-400">{task.id}</span>
						<span className="truncate text-gray-800 dark:text-gray-100">{task.title}</span>
						<span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusChipClass(task.status)}`}>
							{task.status}
						</span>
					</button>
				))}
			</div>
		);

	const renderBadges = (row: Row, base: string | null) => {
		const entry = row.entry;
		const worktree = "missing" in entry ? entry : null;
		return (
			<div className="flex flex-wrap gap-1">
				{worktree?.isMain && <Badge tone="gray">main checkout</Badge>}
				{worktree?.missing && <Badge tone="red">missing path</Badge>}
				{worktree?.locked && <Badge tone="gray">locked</Badge>}
				{entry.safeToClean && base && <Badge tone="green">merged into {base} — safe to clean</Badge>}
				{!entry.safeToClean && entry.mergedIntoBase && entry.atBase && !worktree?.isMain && (
					<Badge tone="gray">same as {base}</Badge>
				)}
				{!entry.safeToClean && entry.mergedIntoBase && !entry.atBase && !worktree?.isMain && (
					<Badge tone="amber">merged into {base}</Badge>
				)}
			</div>
		);
	};

	const renderTable = (title: string, rows: Row[], base: string | null, showPath: boolean) => (
		<section className="mb-8">
			<h2 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
				{title} <span className="text-sm font-normal text-gray-500 dark:text-gray-400">({rows.length})</span>
			</h2>
			{rows.length === 0 ? (
				<div className="text-sm text-gray-500 dark:text-gray-400">None</div>
			) : (
				<div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
					<table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
						<thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
							<tr>
								<th className="px-3 py-2">Branch</th>
								{showPath && <th className="px-3 py-2">Path</th>}
								<th className="px-3 py-2">Tasks</th>
								<th className="px-3 py-2">Ahead / behind</th>
								{showPath && <th className="px-3 py-2">Uncommitted</th>}
								<th className="px-3 py-2">Last commit</th>
								<th className="px-3 py-2">State</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-900">
							{rows.map((row) => {
								const entry = row.entry;
								const worktree = "missing" in entry ? entry : null;
								return (
									<tr key={row.key} className="align-top">
										<td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">
											{row.branch ?? <span className="text-gray-400">(detached {entry.headSha.slice(0, 7)})</span>}
										</td>
										{showPath && (
											<td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-300" title={row.path}>
												{row.path ? shortPath(row.path) : ""}
											</td>
										)}
										<td className="px-3 py-2">{renderTasks(entry.linkedTasks)}</td>
										<td className="whitespace-nowrap px-3 py-2 text-xs text-gray-700 dark:text-gray-200">
											{entry.ahead === null ? "—" : `${entry.ahead} ahead / ${entry.behind} behind`}
										</td>
										{showPath && (
											<td className="whitespace-nowrap px-3 py-2 text-xs text-gray-700 dark:text-gray-200">
												{worktree?.dirtyCount === null || worktree?.dirtyCount === undefined ? (
													"—"
												) : worktree.dirtyCount === 0 ? (
													"clean"
												) : (
													<span className="font-medium text-amber-700 dark:text-amber-300">
														{worktree.dirtyCount} file{worktree.dirtyCount === 1 ? "" : "s"}
													</span>
												)}
											</td>
										)}
										<td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">
											<div className="max-w-sm truncate" title={entry.lastCommitSubject}>
												{entry.lastCommitSubject}
											</div>
											<div className="text-gray-400" title={entry.lastCommitDate}>
												{relativeTime(entry.lastCommitDate)}
											</div>
										</td>
										<td className="px-3 py-2">{renderBadges(row, base)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);

	return (
		<div className="container mx-auto px-4 py-8 transition-colors duration-200">
			<div className="mb-6 flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Worktrees</h1>
				<button
					type="button"
					onClick={() => void load()}
					disabled={loading}
					className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
				>
					{loading ? "Refreshing..." : "Refresh"}
				</button>
			</div>

			{error && (
				<div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
					{error}
				</div>
			)}

			{loading && !report && (
				<div className="flex h-40 items-center justify-center">
					<LoadingSpinner size="lg" text="" />
				</div>
			)}

			{report && !report.configured && (
				<div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
					{report.message}
				</div>
			)}

			{report?.configured && (
				<>
					<div className="mb-4 text-xs text-gray-500 dark:text-gray-400">
						<span className="font-mono">{report.repoRoot}</span>
						{" · base "}
						<span className="font-mono">{report.base ?? "not found"}</span>
						{" · "}
						{relativeTime(report.generatedAt) || "just now"}
					</div>
					{renderTable(
						"Worktrees",
						report.worktrees.map((entry) => ({ key: entry.path, branch: entry.branch, path: entry.path, entry })),
						report.base,
						true,
					)}
					{renderTable(
						"Branches without a worktree",
						report.branches.map((entry) => ({ key: entry.branch, branch: entry.branch, entry })),
						report.base,
						false,
					)}
				</>
			)}
		</div>
	);
};

export default WorktreesPage;
