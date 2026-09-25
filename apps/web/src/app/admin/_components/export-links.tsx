const formats = ["srt", "vtt", "txt"] as const;

/**
 * Download links for `/api/export/[sessionId]`, one row per language.
 * The route sets Content-Disposition, so plain anchors trigger a download.
 */
export function ExportLinks({
	languages,
	sessionId,
}: {
	languages: string[];
	sessionId: string;
}) {
	return (
		<div className="mt-2 flex flex-col gap-1">
			{languages.map((lang) => (
				<div className="flex items-center gap-3 text-sm" key={lang}>
					<span className="w-8 font-mono uppercase">{lang}</span>
					{formats.map((format) => (
						<a
							className="text-cyan uppercase hover:underline"
							href={`/api/export/${sessionId}?format=${format}&lang=${lang}`}
							key={format}
						>
							{format}
						</a>
					))}
				</div>
			))}
		</div>
	);
}
