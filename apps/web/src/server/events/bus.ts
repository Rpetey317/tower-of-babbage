import { EventEmitter } from "node:events";

import type { Event } from "~/lib/contract";

/**
 * In-process fan-out between the events endpoint and the SSE subscriptions.
 * One emitter shared by every route handler and dev reload via `globalThis`.
 * Swap for Redis pub/sub here when the web app runs more than one instance.
 */
const globalForBus = globalThis as unknown as {
	eventBus: EventEmitter | undefined;
};

function getBus(): EventEmitter {
	if (!globalForBus.eventBus) {
		globalForBus.eventBus = new EventEmitter();
		// One listener per open SSE subscription; no fixed ceiling.
		globalForBus.eventBus.setMaxListeners(0);
	}
	return globalForBus.eventBus;
}

export function publish(topic: string, event: Event): void {
	getBus().emit(topic, event);
}

export function subscribe(topic: string): AsyncIterable<Event> {
	const bus = getBus();
	const queue: Event[] = [];
	let wake: (() => void) | undefined;
	let closed = false;

	const listener = (event: Event) => {
		queue.push(event);
		wake?.();
	};
	bus.on(topic, listener);

	const iterable: AsyncIterable<Event> = {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<Event>> {
					while (queue.length === 0) {
						if (closed) return { done: true, value: undefined };
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
						wake = undefined;
					}
					return { done: false, value: queue.shift() as Event };
				},
				async return(): Promise<IteratorResult<Event>> {
					closed = true;
					bus.off(topic, listener);
					wake?.();
					return { done: true, value: undefined };
				},
			};
		},
	};
	return iterable;
}
