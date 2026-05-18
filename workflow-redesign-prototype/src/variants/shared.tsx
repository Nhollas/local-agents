import type { ReactNode } from "react";

export function CodeBlock({ code }: { code: string }) {
	return (
		<pre className="code-block mono">
			{code.split("\n").map((line, i) => (
				<div key={i}>{highlight(line)}</div>
			))}
		</pre>
	);
}

function highlight(line: string): ReactNode {
	// Lightweight tokeniser — keep it dumb, prototype-grade.
	const parts: ReactNode[] = [];
	const rx =
		/(\/\/.*$)|(["'`][^"'`]*["'`])|\b(Effect|Effect<|AsyncIterable|ReadonlyArray|Record|Context\.Tag|Layer|interface|type|class|readonly|const|return)\b|\b([A-Z][A-Za-z0-9]+)\b/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = rx.exec(line)) !== null) {
		if (m.index > last) parts.push(line.slice(last, m.index));
		if (m[1])
			parts.push(
				<span key={i++} className="c">
					{m[1]}
				</span>,
			);
		else if (m[2])
			parts.push(
				<span key={i++} className="s">
					{m[2]}
				</span>,
			);
		else if (m[3])
			parts.push(
				<span key={i++} className="k">
					{m[3]}
				</span>,
			);
		else if (m[4])
			parts.push(
				<span key={i++} className="t">
					{m[4]}
				</span>,
			);
		last = m.index + m[0].length;
	}
	if (last < line.length) parts.push(line.slice(last));
	return parts.length ? parts : line;
}
