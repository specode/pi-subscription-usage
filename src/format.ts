// Formatting model adapted from @narumitw/pi-usage@0.53.0 (MIT).
import {
	sortUsageBuckets,
	usagePercentRemaining,
	usageWindowLabel,
} from "./status.ts";
import type {
	ProviderUsageState,
	UsageBucket,
	UsageMetric,
	UsageReport,
} from "./types.ts";

export { formatUsageStatusline } from "./status.ts";

const BAR_SEGMENTS = 12;

interface PanelRow {
	label: string;
	detail: string;
}

interface PanelSection {
	heading?: string;
	rows: PanelRow[];
}

export function formatUsageReport(report: UsageReport): string {
	const sections = bucketSections(report.buckets);
	const accountRows: PanelRow[] = report.metrics.map((metric) => ({
		label: metricLabel(metric),
		detail: formatMetric(metric),
	}));
	for (const note of report.notes ?? []) accountRows.push(noteRow(note));
	const allRows = [
		...sections.flatMap((section) => section.rows),
		...accountRows,
	];
	const labelWidth = allRows.reduce(
		(width, row) => Math.max(width, displayWidth(row.label)),
		0,
	);
	const grouped = sections.some((section) => Boolean(section.heading));
	const lines = [report.providerName];
	if (!grouped) {
		const rows = [...sections.flatMap((section) => section.rows), ...accountRows];
		lines.push(...formatPanelRows(rows, labelWidth, 2));
		return lines.join("\n");
	}
	for (const section of sections) {
		if (lines.length > 1) lines.push("");
		if (section.heading) lines.push(`  ${section.heading}:`);
		lines.push(...formatPanelRows(section.rows, labelWidth, 4));
	}
	if (accountRows.length > 0) {
		lines.push("", "  Account:");
		lines.push(...formatPanelRows(accountRows, labelWidth, 4));
	}
	return lines.join("\n");
}

export function formatProviderState(state: ProviderUsageState): string {
	if (state.status === "ready") return formatUsageReport(state.report);
	let status = "Query Failed";
	if (state.status === "auth-unavailable") status = "Auth Unavailable";
	else if (state.status === "unsupported") status = "Unsupported";
	return `${state.providerName}\n  ${status}: ${state.message}`;
}

function formatBucket(bucket: UsageBucket): string {
	const remaining = usagePercentRemaining(bucket);
	const reset = bucket.resetsAt
		? ` · resets ${formatReset(bucket.resetsAt)}`
		: "";
	if (remaining !== undefined) {
		const filled = Math.round((remaining / 100) * BAR_SEGMENTS);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}`;
		const percent = `${String(Math.round(remaining)).padStart(3)}%`;
		if (
			bucket.unit !== "percent" &&
			bucket.limit !== undefined &&
			bucket.limit !== 100 && // x/100 duplicates the percent exactly
			bucket.remaining !== undefined
		) {
			return `${bar}  ${percent} left · ${formatNumber(bucket.remaining)}/${formatNumber(bucket.limit)}${reset}`;
		}
		return `${bar}  ${percent} left${reset}`;
	}
	const indent = " ".repeat(BAR_SEGMENTS + 2);
	if (bucket.remaining !== undefined) {
		return `${indent}${formatValue(bucket.remaining, bucket.unit)} left${reset}`;
	}
	return `${indent}${formatValue(bucket.used ?? "n/a", bucket.unit)} used${reset}`;
}

function bucketSections(buckets: readonly UsageBucket[]): PanelSection[] {
	if (!buckets.some((bucket) => bucket.groupId)) {
		return [
			{
				rows: sortUsageBuckets(buckets).map((bucket) => ({
					label: usageWindowLabel(bucket),
					detail: formatBucket(bucket),
				})),
			},
		];
	}
	const groups = new Map<string, { heading: string; buckets: UsageBucket[] }>();
	for (const bucket of buckets) {
		const key = bucket.groupId ?? "other";
		let group = groups.get(key);
		if (!group) {
			group = {
				heading:
					key === "codex"
						? "Shared Across Models"
						: (bucket.groupLabel ?? bucket.groupId ?? "Other Quota"),
				buckets: [],
			};
			groups.set(key, group);
		}
		group.buckets.push(bucket);
	}
	return [...groups.entries()]
		.sort(([leftKey, left], [rightKey, right]) => {
			if (leftKey === "codex") return -1;
			if (rightKey === "codex") return 1;
			return left.heading.localeCompare(right.heading);
		})
		.map(([, group]) => ({
			heading: group.heading,
			rows: sortUsageBuckets(group.buckets).map((bucket) => ({
				label: usageWindowLabel(bucket),
				detail: formatBucket(bucket),
			})),
		}));
}

function formatPanelRows(
	rows: readonly PanelRow[],
	labelWidth: number,
	indent: number,
): string[] {
	const prefix = " ".repeat(indent);
	return rows.map(
		(row) => `${prefix}${padDisplayEnd(row.label, labelWidth)}  ${row.detail}`,
	);
}

function metricLabel(metric: UsageMetric): string {
	if (metric.id === "reset-credits") return "Resets Left";
	if (metric.id === "credits") return "Extra Credit";
	if (metric.id === "included-used") return "Included Used";
	if (metric.id === "included-limit") return "Included Total";
	if (metric.id === "on-demand-used") return "On-Demand Used";
	if (metric.id === "on-demand-cap") return "On-Demand Cap";
	if (metric.id === "prepaid-balance") return "Prepaid Balance";
	return metric.label;
}

function formatMetric(metric: UsageMetric): string {
	if (metric.id === "reset-credits" && typeof metric.value === "number") {
		return formatNumber(metric.value);
	}
	return formatValue(metric.value, metric.unit);
}

function noteRow(note: string): PanelRow {
	if (note.startsWith("Plan: ")) {
		return { label: "Plan", detail: note.slice("Plan: ".length) };
	}
	if (note === "On-demand billing: enabled") {
		return { label: "On-Demand", detail: "on" };
	}
	if (note === "On-demand billing: disabled") {
		return { label: "On-Demand", detail: "off" };
	}
	return { label: "Note", detail: note };
}

function formatValue(
	value: number | string,
	unit: UsageBucket["unit"] | undefined,
): string {
	if (unit === "usd" && typeof value === "number") return `$${value.toFixed(2)}`;
	return typeof value === "number" ? formatNumber(value) : value;
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatReset(epochSeconds: number): string {
	const reset = new Date(epochSeconds * 1_000);
	if (Number.isNaN(reset.getTime())) return "unknown";
	const month = (reset.getMonth() + 1).toString().padStart(2, "0");
	const day = reset.getDate().toString().padStart(2, "0");
	const hour = reset.getHours().toString().padStart(2, "0");
	const minute = reset.getMinutes().toString().padStart(2, "0");
	return `${month}/${day} ${hour}:${minute}`;
}

// East Asian display width so CJK labels can be padded into a real grid.
function displayWidth(value: string): number {
	let width = 0;
	for (const char of value) {
		width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return width;
}

function isWideCodePoint(code: number): boolean {
	return (
		code >= 0x1100 &&
		(code <= 0x115f ||
			code === 0x2329 ||
			code === 0x232a ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x20000 && code <= 0x3fffd))
	);
}

function padDisplayEnd(value: string, width: number): string {
	const padding = width - displayWidth(value);
	return padding > 0 ? value + " ".repeat(padding) : value;
}
