import { useEffect, useReducer } from "react";
import { CodeFirstVariant } from "./variants/code-first.tsx";
import { LayeredVariant } from "./variants/layered.tsx";
import { PipelineVariant } from "./variants/pipeline.tsx";
import { ServicesVariant } from "./variants/services.tsx";

type VariantDef = {
	key: string;
	name: string;
	tagline: string;
	render: () => JSX.Element;
};

const VARIANTS: VariantDef[] = [
	{
		key: "pipeline",
		name: "Pipeline lanes",
		tagline: "L→R run-lifecycle, engine vs orchestrator swimlanes",
		render: () => <PipelineVariant />,
	},
	{
		key: "layered",
		name: "Layered modules",
		tagline: "Module boundaries top-down; current → target diff",
		render: () => <LayeredVariant />,
	},
	{
		key: "services",
		name: "Services-in-middle",
		tagline: "Two Tags as bus; engine left, orchestrator right",
		render: () => <ServicesVariant />,
	},
	{
		key: "code-first",
		name: "Code-first browser",
		tagline: "File tree + inlined signatures; IDE-like drill-down",
		render: () => <CodeFirstVariant />,
	},
];

function readVariant(): string {
	const v = new URLSearchParams(window.location.search).get("v");
	return VARIANTS.some((x) => x.key === v) ? (v as string) : VARIANTS[0].key;
}

function writeVariant(key: string) {
	const url = new URL(window.location.href);
	url.searchParams.set("v", key);
	window.history.replaceState({}, "", url.toString());
}

export function App() {
	const [, bump] = useReducer((x: number) => x + 1, 0);
	const current = readVariant();
	const def = VARIANTS.find((v) => v.key === current) ?? VARIANTS[0];

	function setVariant(k: string) {
		writeVariant(k);
		bump();
	}

	useEffect(() => {
		const onPop = () => bump();
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const t = e.target as HTMLElement | null;
			if (
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable)
			)
				return;
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			const i = VARIANTS.findIndex((v) => v.key === current);
			const next =
				e.key === "ArrowRight"
					? VARIANTS[(i + 1) % VARIANTS.length]
					: VARIANTS[(i - 1 + VARIANTS.length) % VARIANTS.length];
			setVariant(next.key);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [current]);

	return (
		<>
			<div className="page">
				<div className="header">
					<div>
						<div className="title">
							server/workflow/ — target design <em>· throwaway prototype</em>
						</div>
						<div className="sub">
							Post-redesign module shape, public surface, event flow & DI
							wiring. Switch variants below.
						</div>
					</div>
					<div className="sub mono">?v={current}</div>
				</div>
				<Legend />
				{def.render()}
			</div>
			<Switcher variants={VARIANTS} current={current} onChange={setVariant} />
		</>
	);
}

function Legend() {
	return (
		<div className="legend">
			<span>
				<span className="dot" style={{ background: "var(--engine)" }} />
				workflow/ (engine)
			</span>
			<span>
				<span className="dot" style={{ background: "var(--orch)" }} />
				orchestrator/
			</span>
			<span>
				<span className="dot" style={{ background: "var(--shared)" }} />
				Tag / shared interface
			</span>
			<span>
				<span className="dot" style={{ background: "var(--danger)" }} />
				DELETES in target
			</span>
			<span>
				<span className="dot" style={{ background: "var(--tbd)" }} />
				TBD
			</span>
			<span>
				<span className="dot" style={{ background: "var(--event)" }} />
				WorkflowEvent
			</span>
		</div>
	);
}

function Switcher({
	variants,
	current,
	onChange,
}: {
	variants: VariantDef[];
	current: string;
	onChange: (k: string) => void;
}) {
	const i = variants.findIndex((v) => v.key === current);
	const def = variants[i] ?? variants[0];
	const prev = variants[(i - 1 + variants.length) % variants.length];
	const next = variants[(i + 1) % variants.length];
	return (
		<div className="switcher" role="navigation" aria-label="Prototype variants">
			<button
				type="button"
				onClick={() => onChange(prev.key)}
				aria-label="Previous variant"
			>
				◀
			</button>
			<div className="label">
				<b>{def.key}</b> — {def.name}
				<div style={{ color: "var(--muted)", fontSize: 11 }}>{def.tagline}</div>
			</div>
			<button
				type="button"
				onClick={() => onChange(next.key)}
				aria-label="Next variant"
			>
				▶
			</button>
			<span className="keys">
				← / → · {i + 1} of {variants.length}
			</span>
		</div>
	);
}
