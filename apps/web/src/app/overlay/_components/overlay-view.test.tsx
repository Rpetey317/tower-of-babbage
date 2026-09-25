import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CaptionSegment, SessionStatus } from "~/lib/captions";
import { resolveOverlayParams } from "~/lib/overlay";

import { OverlayView } from "./overlay-view";

const subscription = vi.hoisted(() => ({ status: "pending" }));

vi.mock("~/trpc/react", () => ({
	api: {
		segments: {
			recent: { useQuery: () => ({ data: [] }) },
			onSegment: {
				useSubscription: () => ({ status: subscription.status }),
			},
		},
	},
}));

const session = {
	id: "1a5696cd-7cb5-42d1-8bc8-2bd891732f4e",
	sourceLanguage: "en",
	status: "running" as const,
};

function segment(
	chunkIndex: number,
	kind: "original" | "translation",
	text: string,
	language = kind === "original" ? "en" : "es",
): CaptionSegment {
	return {
		type: "segment",
		sessionId: session.id,
		runId: "aaaaaaaa-1111-4222-8333-444444444444",
		chunkIndex,
		kind,
		language,
		text,
		isFinal: true,
		startMs: chunkIndex * 5000,
		endMs: chunkIndex * 5000 + 4000,
		emittedAt: "2026-09-25T15:00:00.000Z",
		latencyMs: 1200,
	};
}

function render(opts: {
	query?: Record<string, string>;
	status?: SessionStatus;
	segments?: CaptionSegment[];
	subStatus?: string;
}) {
	subscription.status = opts.subStatus ?? "pending";
	const params = resolveOverlayParams({
		query: opts.query ?? {},
		sourceLanguage: "en",
		targetLanguages: ["es"],
	});
	return renderToStaticMarkup(
		createElement(OverlayView, {
			initialSegments: opts.segments ?? [],
			params,
			session: { ...session, status: opts.status ?? "running" },
		}),
	);
}

const threeChunks = [
	segment(0, "translation", "Linea uno"),
	segment(1, "translation", "Linea dos"),
	segment(2, "translation", "Linea tres"),
];

describe("OverlayView", () => {
	it("renders the fixed transparent container with hidden cursor", () => {
		const html = render({ segments: threeChunks });
		expect(html).toContain("fixed inset-0");
		expect(html).toContain("cursor-none");
		expect(html).toContain("font-caption");
	});

	it("shows at most `lines` entries, newest last", () => {
		const html = render({ query: { lines: "2" }, segments: threeChunks });
		expect(html).not.toContain("Linea uno");
		expect(html).toContain("Linea dos");
		expect(html).toContain("Linea tres");
		expect(html).toContain("max-height:2.7em");
		expect((html.match(/<p /g) ?? []).length).toBe(2);
	});

	it("stacks muted original over translation in both mode", () => {
		const html = render({
			query: { mode: "both" },
			segments: [
				segment(0, "original", "Original words"),
				segment(0, "translation", "Palabras traducidas"),
			],
		});
		expect(html.indexOf("Original words")).toBeLessThan(
			html.indexOf("Palabras traducidas"),
		);
		expect(html).toContain('lang="en"');
		expect(html).toContain('lang="es"');
		expect(html).toContain("text-ink-300");
	});

	it("applies band, box and none backgrounds", () => {
		expect(render({ segments: threeChunks })).toContain("bg-ink-900/80");
		const box = render({ query: { bg: "box" }, segments: threeChunks });
		expect(box).toContain("box-decoration-clone");
		const none = render({ query: { bg: "none" }, segments: threeChunks });
		expect(none).not.toContain("bg-ink-900/80");
	});

	it("aligns to the top and scales size and margin with the viewport", () => {
		const html = render({
			query: { align: "top", size: "72", margin: "32" },
			segments: threeChunks,
		});
		expect(html).toContain("justify-content:flex-start");
		expect(html).toContain("font-size:calc(72 * 100vw / 1920)");
		expect(html).toContain("padding:calc(32 * 100vw / 1920)");
	});

	it("adds the fade class only with anim=fade", () => {
		expect(
			render({ query: { anim: "fade" }, segments: threeChunks }),
		).toContain("overlay-fade");
		expect(render({ segments: threeChunks })).not.toContain("overlay-fade");
	});

	it("renders nothing when the session is not live", () => {
		expect(render({ status: "idle", segments: threeChunks })).toBe("");
		expect(render({ status: "error", segments: threeChunks })).toBe("");
	});

	it("renders nothing while the subscription is disconnected", () => {
		expect(render({ segments: threeChunks, subStatus: "error" })).toBe("");
	});
});
