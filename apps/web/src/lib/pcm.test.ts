import { describe, expect, it } from "vitest";

import { frameSamples, PcmFramer, targetSampleRate } from "./pcm";

function readInt16(frame: ArrayBuffer, index: number) {
	return new DataView(frame).getInt16(index * 2, true);
}

describe("PcmFramer", () => {
	it("emits one 6400-byte frame per 3200 source samples at 16 kHz", () => {
		const framer = new PcmFramer(targetSampleRate);
		const frames = framer.push(new Float32Array(frameSamples));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.frame.byteLength).toBe(frameSamples * 2);
		expect(frames[0]?.rms).toBe(0);
		expect(readInt16(frames[0]?.frame ?? new ArrayBuffer(0), 0)).toBe(0);
	});

	it("accumulates partial blocks until a frame is complete", () => {
		const framer = new PcmFramer(targetSampleRate);
		expect(framer.push(new Float32Array(1600).fill(0.5))).toHaveLength(0);
		expect(framer.push(new Float32Array(1600).fill(0.5))).toHaveLength(1);
	});

	it("maps Float32 amplitude to Int16 little-endian and clamps", () => {
		const framer = new PcmFramer(targetSampleRate);
		const input = new Float32Array(frameSamples);
		input[0] = 1;
		input[1] = -1;
		input[2] = 2; // clamp to +1
		input[3] = -2; // clamp to -1
		const [frame] = framer.push(input);
		expect(readInt16(frame?.frame ?? new ArrayBuffer(0), 0)).toBe(32767);
		expect(readInt16(frame?.frame ?? new ArrayBuffer(0), 1)).toBe(-32768);
		expect(readInt16(frame?.frame ?? new ArrayBuffer(0), 2)).toBe(32767);
		expect(readInt16(frame?.frame ?? new ArrayBuffer(0), 3)).toBe(-32768);
	});

	it("reports RMS of the frame content", () => {
		const framer = new PcmFramer(targetSampleRate);
		const input = new Float32Array(frameSamples).fill(0.5);
		const [frame] = framer.push(input);
		expect(frame?.rms).toBeCloseTo(0.5, 2);
	});

	it("resamples linearly when the source rate differs", () => {
		const framer = new PcmFramer(48000);
		// A constant signal resamples to the same constant.
		const frames = framer.push(new Float32Array(9600).fill(0.25));
		expect(frames).toHaveLength(1);
		expect(readInt16(frames[0]?.frame ?? new ArrayBuffer(0), 100)).toBe(
			Math.round(0.25 * 32767),
		);
	});

	it("keeps emitting frames across the buffer boundary when resampling", () => {
		const framer = new PcmFramer(48000);
		let total = 0;
		// 100 pushes of 960 samples = 2 s at 48 kHz -> ten 200 ms frames.
		for (let i = 0; i < 100; i++) {
			total += framer.push(new Float32Array(960).fill(0.1)).length;
		}
		expect(total).toBe(10);
	});
});
