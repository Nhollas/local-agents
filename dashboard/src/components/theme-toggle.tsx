import { useEffect, useState } from "react";

export function ThemeToggle() {
	const [theme, setTheme] = useState<string | null>(null);

	useEffect(() => {
		setTheme(document.documentElement.getAttribute("data-theme") ?? "dark");
	}, []);

	if (!theme) return <div className="h-8 w-8" />;

	const isDark = theme === "dark";

	return (
		<button
			type="button"
			onClick={() => {
				const next = isDark ? "light" : "dark";
				document.documentElement.setAttribute("data-theme", next);
				localStorage.setItem("theme", next);
				setTheme(next);
			}}
			aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
			className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-secondary"
		>
			{isDark ? (
				<svg
					aria-hidden="true"
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
				>
					<circle cx="8" cy="8" r="2.5" />
					<path d="M8 1.5v2m0 9v2m-6.5-6.5h2m9 0h2M3.4 3.4l1.4 1.4m6.8 6.8 1.4 1.4M3.4 12.6l1.4-1.4m6.8-6.8 1.4-1.4" />
				</svg>
			) : (
				<svg
					aria-hidden="true"
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M13.5 9A5.5 5.5 0 1 1 7 2.5 4 4 0 0 0 13.5 9Z" />
				</svg>
			)}
		</button>
	);
}
