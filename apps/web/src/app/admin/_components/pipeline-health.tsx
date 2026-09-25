"use client";

import type { Dictionary } from "~/lib/i18n";
import { api } from "~/trpc/react";

/**
 * Pipeline health card on the dashboard: polls `admin.pipelineHealth`
 * (a `GET /healthz` proxy) every 5 s. Coral when unreachable or when an
 * endpoint reports unhealthy.
 */
export function PipelineHealth({ copy }: { copy: Dictionary }) {
	const health = api.admin.pipelineHealth.useQuery(undefined, {
		refetchInterval: 5_000,
	});

	const data = health.data;
	const reachable = data?.ok === true;
	const endpointsDown =
		reachable && data.health.endpoints.some((endpoint) => !endpoint.healthy);
	const dot = reachable && !endpointsDown ? "bg-green" : "bg-coral";

	return (
		<section className="mt-6 rounded-md border border-ink-700 px-4 py-3">
			<div className="flex flex-wrap items-center gap-x-6 gap-y-2">
				<span className="flex items-center gap-2 font-semibold">
					<span
						aria-hidden="true"
						className={`h-2.5 w-2.5 rounded-full ${dot}`}
					/>
					{copy.adminPipelineTitle}
				</span>
				{!reachable ? (
					<span className="text-coral text-sm">
						{copy.adminPipelineUnreachable}
						{data && !data.ok ? ` — ${data.error}` : ""}
					</span>
				) : (
					<>
						<span className="text-ink-300 text-sm">
							{copy.adminPipelineProvider}:{" "}
							<span className="text-ink-100">{data.health.provider}</span>
						</span>
						<span className="flex items-center gap-2 text-ink-300 text-sm">
							{copy.adminPipelineEndpoints}:
							{data.health.endpoints.map((endpoint) => (
								<span className="flex items-center gap-1" key={endpoint.url}>
									<span
										aria-hidden="true"
										className={`h-2 w-2 rounded-full ${endpoint.healthy ? "bg-green" : "bg-coral"}`}
									/>
									{endpoint.url}
								</span>
							))}
						</span>
						<span className="text-ink-300 text-sm">
							{copy.adminPipelineActiveSessions}:{" "}
							<span className="text-ink-100">{data.health.activeSessions}</span>
						</span>
					</>
				)}
			</div>
		</section>
	);
}
