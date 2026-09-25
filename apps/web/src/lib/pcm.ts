/** PCM framing for the operator page (contract section 4): 16 kHz mono
 * s16le frames of 200 ms posted to the ingest WebSocket. The AudioWorklet
 * forwards raw Float32 blocks; this class resamples (linearly) when the
 * AudioContext could not honor 16 kHz, converts to Int16 and emits complete
 * frames with an RMS level for the meter. */
export const targetSampleRate = 16000;
export const frameDurationMs = 200;
export const frameSamples = (targetSampleRate * frameDurationMs) / 1000;

export interface PcmFrame {
	/** 6400 bytes, signed 16-bit little-endian. */
	frame: ArrayBuffer;
	/** 0..1 level of the produced frame, for the meter. */
	rms: number;
}

export class PcmFramer {
	private readonly ratio: number;
	private pending: Float32Array = new Float32Array(0);
	private cursor = 0;

	constructor(sourceRate: number = targetSampleRate) {
		if (sourceRate <= 0) throw new Error("sourceRate must be positive");
		this.ratio = sourceRate / targetSampleRate;
	}

	push(input: Float32Array): PcmFrame[] {
		if (input.length === 0) return [];
		const merged = new Float32Array(this.pending.length + input.length);
		merged.set(this.pending);
		merged.set(input, this.pending.length);
		this.pending = merged;

		const frames: PcmFrame[] = [];
		// The last output sample reads source index cursor + (N-1)*ratio;
		// ceil() of it must exist in the buffer (exact positions skip the
		// interpolation partner via the `?? a` fallback in emitFrame).
		while (
			Math.ceil(this.cursor + (frameSamples - 1) * this.ratio) <=
			this.pending.length - 1
		) {
			frames.push(this.emitFrame());
		}

		// Samples before floor(cursor) can no longer be read.
		const drop = Math.floor(this.cursor);
		if (drop > 0) {
			this.pending = this.pending.subarray(drop);
			this.cursor -= drop;
		}
		return frames;
	}

	private emitFrame(): PcmFrame {
		const out = new Int16Array(frameSamples);
		let sumSquares = 0;
		for (let i = 0; i < frameSamples; i++) {
			const position = this.cursor + i * this.ratio;
			const index = Math.floor(position);
			const fraction = position - index;
			const a = this.pending[index] ?? 0;
			const b = this.pending[index + 1] ?? a;
			const sample = Math.max(-1, Math.min(1, a + (b - a) * fraction));
			const s16 = sample < 0 ? sample * 32768 : sample * 32767;
			out[i] = Math.round(s16);
			sumSquares += sample * sample;
		}
		this.cursor += frameSamples * this.ratio;

		const bytes = new Uint8Array(frameSamples * 2);
		const view = new DataView(bytes.buffer);
		for (let i = 0; i < frameSamples; i++) {
			view.setInt16(i * 2, out[i] ?? 0, true);
		}
		return {
			frame: bytes.buffer,
			rms: Math.sqrt(sumSquares / frameSamples),
		};
	}
}
