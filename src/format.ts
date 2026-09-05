// Formatting model adapted from @narumitw/pi-usage@0.53.0 (MIT).
import {
	DEFAULT_USAGE_DISPLAY_MODE,
	formatUsagePercent,
	usageAmount,
	usagePercent,
	type UsageDisplayMode,
} from "./display.ts";
import { sortUsageBuckets, usageWindowLabel } from "./status.ts";
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

export function formatUsageReport(
	report: UsageReport,
	displayMode: UsageDisplayMode = DEFAULT_USAGE_DISPLAY_MODE,
): string {
	const sections = bucketSections(report, displayMode);
	const accountRows: PanelRow[] = report.metrics.map((metric) => ({
		label: metric.label,
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
		const rows = sections.flatMap((section) => section.rows);
		lines.push(...formatPanelRows(rows, labelWidth, 2));
		if (accountRows.length > 0) {
			lines.push("", "  Account:");
			lines.push(...formatPanelRows(accountRows, labelWidth, 4));
		}
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

export function formatProviderState(
	state: ProviderUsageState,
	displayMode: UsageDisplayMode = DEFAULT_USAGE_DISPLAY_MODE,
): string {
	if (state.status === "ready") {
		return formatUsageReport(state.report, displayMode);
	}
	let status = "Query Failed";
	if (state.status === "auth-unavailable") status = "Auth Unavailable";
	else if (state.status === "unsupported") status = "Unsupported";
	return `${state.providerName}\n  ${status}: ${state.message}`;
}

function formatBucket(
	bucket: UsageBucket,
	displayMode: UsageDisplayMode,
): string {
	const selectedPercent = usagePercent(bucket, displayMode);
	const selectedAmount = usageAmount(bucket, displayMode);
	const qualifier = displayMode === "used" ? "used" : "left";
	const reset = bucket.resetsAt
		? ` · resets ${formatReset(bucket.resetsAt)}`
		: "";
	if (selectedPercent !== undefined) {
		const filled = Math.round((selectedPercent / 100) * BAR_SEGMENTS);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}`;
		const percent = `${formatUsagePercent(selectedPercent).padStart(3)}%`;
		if (
			bucket.unit !== "percent" &&
			bucket.limit !== undefined &&
			bucket.limit !== 100 && // x/100 duplicates the percent exactly
			selectedAmount !== undefined
		) {
			return `${bar}  ${percent} ${qualifier} · ${formatNumber(selectedAmount)}/${formatNumber(bucket.limit)}${reset}`;
		}
		return `${bar}  ${percent} ${qualifier}${reset}`;
	}
	const indent = " ".repeat(BAR_SEGMENTS + 2);
	return `${indent}${formatValue(selectedAmount ?? "n/a", bucket.unit)} ${qualifier}${reset}`;
}

function bucketSections(
	report: UsageReport,
	displayMode: UsageDisplayMode,
): PanelSection[] {
	if (!report.buckets.some((bucket) => bucket.groupId)) {
		return [
			{
				rows: sortUsageBuckets(report.buckets).map((bucket) => ({
					label: usageWindowLabel(bucket),
					detail: formatBucket(bucket, displayMode),
				})),
			},
		];
	}
	const groups = new Map<string, { heading: string; buckets: UsageBucket[] }>();
	for (const bucket of report.buckets) {
		const key = bucket.groupId ?? "other";
		let group = groups.get(key);
		if (!group) {
			group = {
				heading: bucket.groupLabel ?? bucket.groupId ?? "Other Quota",
				buckets: [],
			};
			groups.set(key, group);
		}
		group.buckets.push(bucket);
	}
	return [...groups.entries()]
		.sort(([leftKey, left], [rightKey, right]) => {
			if (leftKey === report.defaultGroupId) return -1;
			if (rightKey === report.defaultGroupId) return 1;
			return left.heading.localeCompare(right.heading);
		})
		.map(([, group]) => ({
			heading: group.heading,
			rows: sortUsageBuckets(group.buckets).map((bucket) => ({
				label: usageWindowLabel(bucket),
				detail: formatBucket(bucket, displayMode),
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

function formatMetric(metric: UsageMetric): string {
	return formatValue(metric.value, metric.unit);
}

function noteRow(note: string): PanelRow {
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
