"use client";

import { useEffect, useRef, useState } from "react";

import {
	ConnectionPill,
	type PillKind,
} from "~/app/_components/connection-pill";
import { ingestReadySchema, ingestStatsSchema } from "~/lib/contract";
import { PcmFramer, targetSampleRate } from "~/lib/pcm";
import { api } from "~/trpc/react";

const workletPath = "/operator-mic.worklet.js";
// Frames buffered while the socket is still in the hello/ready handshake.
const maxQueuedFrames = 50;
const reconnectBaseMs = 1000;
const reconnectCapMs = 5000;

type Phase = "off" | "connecting" | "live" | "reconnecting";

interface AudioGraph {
	context: AudioContext;
	source: MediaStreamAudioSourceNode;
	node: AudioWorkletNode;
	gain: GainNode;
}

function teardownAudio(audio: AudioGraph | null, stream: MediaStream | null) {
	for (const track of stream?.getTracks() ?? []) track.stop();
	if (!audio) return;
	audio.source.disconnect();
	audio.node.disconnect();
	audio.gain.disconnect();
	void audio.context.close();
}

function formatMs(ms: number) {
	const total = Math.floor(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Microphone capture console (contract section 4). Streams 200 ms s16le PCM
 * frames over the ingest WebSocket; reconnects with a freshly minted token
 * every attempt. Audio time only advances on the pipeline with received
 * samples, so frames dropped during a reconnect create no gap.
 */
export function OperatorConsole({
	sessionId,
	sourceType,
	wsUrl,
	copy,
}: {
	sessionId: string;
	sourceType: string;
	wsUrl: string;
	copy: Record<string, string>;
}) {
	const [phase, setPhase] = useState<Phase>("off");
	const [level, setLevel] = useState(0);
	const [audioReceivedMs, setAudioReceivedMs] = useState(0);
	const [queueDepth, setQueueDepth] = useState<number | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [processing, setProcessing] = useState(false);

	const mintToken = api.admin.ingestToken.useMutation();

	const streamRef = useRef<MediaStream | null>(null);
	const audioRef = useRef<AudioGraph | null>(null);
	const framerRef = useRef<PcmFramer | null>(null);
	const socketRef = useRef<WebSocket | null>(null);
	const socketReadyRef = useRef(false);
	const pendingFramesRef = useRef<ArrayBuffer[]>([]);
	const stoppingRef = useRef(false);
	const attemptsRef = useRef(0);
	const retryTimerRef = useRef<number | null>(null);

	const handleSamples = (samples: Float32Array) => {
		const framer = framerRef.current;
		if (!framer) return;
		for (const { frame, rms } of framer.push(samples)) {
			setLevel(rms);
			const socket = socketRef.current;
			if (socket?.readyState === WebSocket.OPEN && socketReadyRef.current) {
				socket.send(frame);
			} else if (socket && socket.readyState !== WebSocket.CLOSED) {
				const queue = pendingFramesRef.current;
				queue.push(frame);
				if (queue.length > maxQueuedFrames) queue.shift();
			}
		}
	};

	const scheduleReconnect = () => {
		if (stoppingRef.current || retryTimerRef.current !== null) return;
		attemptsRef.current += 1;
		const delay = Math.min(
			reconnectBaseMs * attemptsRef.current,
			reconnectCapMs,
		);
		retryTimerRef.current = window.setTimeout(() => {
			retryTimerRef.current = null;
			void connect();
		}, delay);
	};

	const connect = async () => {
		if (stoppingRef.current || socketRef.current) return;
		let token: string;
		try {
			({ token } = await mintToken.mutateAsync({ sessionId }));
		} catch {
			setPhase("reconnecting");
			scheduleReconnect();
			return;
		}
		const socket = new WebSocket(
			`${wsUrl}/v1/sessions/${sessionId}/ingest?token=${encodeURIComponent(token)}`,
		);
		socket.binaryType = "arraybuffer";
		socketRef.current = socket;
		socketReadyRef.current = false;
		// A stuck CONNECTING socket (e.g. blackholed network) never fires
		// close; force it so the retry loop keeps going.
		const connectTimeout = window.setTimeout(() => {
			if (!socketReadyRef.current) socket.close();
		}, 8000);

		socket.onopen = () => {
			socket.send(
				JSON.stringify({
					type: "hello",
					format: "pcm_s16le",
					sampleRate: targetSampleRate,
					channels: 1,
				}),
			);
		};
		socket.onmessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			let raw: unknown;
			try {
				raw = JSON.parse(event.data);
			} catch {
				return;
			}
			const ready = ingestReadySchema.safeParse(raw);
			if (ready.success) {
				clearTimeout(connectTimeout);
				socketReadyRef.current = true;
				attemptsRef.current = 0;
				setPhase("live");
				setNotice(null);
				for (const frame of pendingFramesRef.current.splice(0)) {
					socket.send(frame);
				}
				return;
			}
			const stats = ingestStatsSchema.safeParse(raw);
			if (stats.success) {
				setAudioReceivedMs(stats.data.audioReceivedMs);
				setQueueDepth(stats.data.queueDepth);
			}
		};
		socket.onclose = (event) => {
			clearTimeout(connectTimeout);
			if (socketRef.current === socket) socketRef.current = null;
			socketReadyRef.current = false;
			pendingFramesRef.current = [];
			if (stoppingRef.current) return;
			setPhase("reconnecting");
			setNotice(
				event.code === 4004
					? (copy.operatorNotRunning ?? "")
					: `${copy.operatorCloseReason}: ${event.code}${
							event.reason ? ` ${event.reason}` : ""
						}`,
			);
			scheduleReconnect();
		};
	};

	const startAudio = async (withProcessing: boolean): Promise<boolean> => {
		if (!navigator.mediaDevices?.getUserMedia) {
			setNotice(copy.operatorMicError ?? "");
			return false;
		}
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: withProcessing,
					noiseSuppression: withProcessing,
					autoGainControl: withProcessing,
				},
			});
		} catch {
			setNotice(copy.operatorMicError ?? "");
			return false;
		}
		try {
			const context = new AudioContext({ sampleRate: targetSampleRate });
			await context.audioWorklet.addModule(workletPath);
			const source = context.createMediaStreamSource(stream);
			const node = new AudioWorkletNode(context, "operator-mic");
			// The worklet must be connected to run; the zero gain keeps the mic
			// off the speakers.
			const gain = context.createGain();
			gain.gain.value = 0;
			source.connect(node);
			node.connect(gain);
			gain.connect(context.destination);
			framerRef.current = new PcmFramer(context.sampleRate);
			node.port.onmessage = (event: MessageEvent<Float32Array>) => {
				if (event.data instanceof Float32Array) handleSamples(event.data);
			};
			streamRef.current = stream;
			audioRef.current = { context, source, node, gain };
			return true;
		} catch {
			for (const track of stream.getTracks()) track.stop();
			setNotice(copy.operatorMicError ?? "");
			return false;
		}
	};

	const start = async () => {
		stoppingRef.current = false;
		setNotice(null);
		setPhase("connecting");
		setAudioReceivedMs(0);
		if (await startAudio(processing)) {
			void connect();
		} else {
			setPhase("off");
		}
	};

	const stop = () => {
		stoppingRef.current = true;
		if (retryTimerRef.current !== null) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		const socket = socketRef.current;
		socketRef.current = null;
		socketReadyRef.current = false;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "end" }));
		}
		socket?.close();
		teardownAudio(audioRef.current, streamRef.current);
		audioRef.current = null;
		streamRef.current = null;
		pendingFramesRef.current = [];
		setPhase("off");
		setLevel(0);
		setQueueDepth(null);
	};

	const reconnectNow = () => {
		if (retryTimerRef.current !== null) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		const socket = socketRef.current;
		socketRef.current = null;
		socketReadyRef.current = false;
		socket?.close();
		setPhase("connecting");
		void connect();
	};

	const toggleProcessing = async (enabled: boolean) => {
		setProcessing(enabled);
		if (phase === "off") return;
		// Constraints are fixed at getUserMedia time, so the capture restarts.
		// The socket stays open; audio time does not advance meanwhile.
		teardownAudio(audioRef.current, streamRef.current);
		audioRef.current = null;
		streamRef.current = null;
		await startAudio(enabled);
	};

	useEffect(
		() => () => {
			stoppingRef.current = true;
			if (retryTimerRef.current !== null) {
				clearTimeout(retryTimerRef.current);
			}
			const socket = socketRef.current;
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "end" }));
			}
			socket?.close();
			teardownAudio(audioRef.current, streamRef.current);
		},
		[],
	);

	const pillKind: PillKind =
		phase === "live" ? "live" : phase === "off" ? "notlive" : "reconnecting";
	const pillLabel =
		phase === "live"
			? copy.connLive
			: phase === "off"
				? copy.connNotLive
				: copy.operatorStatusConnecting;

	const capturing = phase !== "off";

	return (
		<section className="mt-6 rounded-lg border border-ink-700 p-6">
			<div className="flex items-center justify-between gap-4">
				<ConnectionPill kind={pillKind} label={pillLabel ?? ""} />
				{capturing ? (
					<button
						className="rounded-md bg-orange px-4 py-2 font-semibold text-ink-950 text-sm"
						onClick={stop}
						type="button"
					>
						{copy.operatorStopCapture}
					</button>
				) : (
					<button
						className="rounded-md bg-green px-4 py-2 font-semibold text-ink-950 text-sm"
						onClick={() => void start()}
						type="button"
					>
						{copy.operatorStartCapture}
					</button>
				)}
			</div>

			{sourceType !== "browser_mic" && (
				<p className="mt-4 text-orange text-sm">{copy.operatorWrongSource}</p>
			)}
			{notice && <p className="mt-4 text-coral text-sm">{notice}</p>}

			<div className="mt-6">
				<span className="text-ink-300 text-xs uppercase">
					{copy.operatorLevel}
				</span>
				<div className="mt-1 h-3 rounded bg-ink-700">
					<div
						className="h-full rounded bg-green transition-[width] duration-100"
						style={{ width: `${Math.min(100, level * 300)}%` }}
					/>
				</div>
			</div>

			<dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
				<div>
					<dt className="text-ink-300">{copy.operatorAudioReceived}</dt>
					<dd className="font-mono text-2xl">{formatMs(audioReceivedMs)}</dd>
				</div>
				<div>
					<dt className="text-ink-300">{copy.operatorQueueDepth}</dt>
					<dd className="font-mono text-2xl">{queueDepth ?? "—"}</dd>
				</div>
			</dl>

			<div className="mt-6 flex items-center gap-4">
				{capturing && (
					<button
						className="rounded-md bg-ink-700 px-3 py-1 font-semibold text-ink-100 text-sm"
						onClick={reconnectNow}
						type="button"
					>
						{copy.operatorReconnect}
					</button>
				)}
				<label className="flex items-center gap-2 text-ink-300 text-sm">
					<input
						checked={processing}
						className="accent-violet"
						onChange={(event) => void toggleProcessing(event.target.checked)}
						type="checkbox"
					/>
					{copy.operatorProcessing}
				</label>
			</div>
		</section>
	);
}
