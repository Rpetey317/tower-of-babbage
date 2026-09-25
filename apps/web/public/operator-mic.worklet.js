// @ts-nocheck -- AudioWorklet globals (AudioWorkletProcessor,
// registerProcessor, port) only exist inside the worklet scope.
// AudioWorkletProcessor for the operator page. It forwards each mono input
// block to the main thread, which frames it into 200 ms s16le PCM for the
// ingest WebSocket (contract section 4). Conversion lives on the main thread
// in src/lib/pcm.ts so it stays unit-testable.
class OperatorMicProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (channel && channel.length > 0) {
			// The audio thread reuses this buffer; post a copy.
			this.port.postMessage(channel.slice(0));
		}
		return true;
	}
}

registerProcessor("operator-mic", OperatorMicProcessor);
