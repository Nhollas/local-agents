import { describe, expect, it } from "vitest";
import { parseShortstat } from "./parse-shortstat.ts";

describe("parseShortstat", () => {
	it("parses the canonical insertions-and-deletions form", () => {
		expect(
			parseShortstat(" 3 files changed, 27 insertions(+), 4 deletions(-)\n"),
		).toEqual({ filesChanged: 3, linesAdded: 27, linesRemoved: 4 });
	});

	it("treats a missing insertions clause as zero", () => {
		expect(parseShortstat(" 2 files changed, 5 deletions(-)\n")).toEqual({
			filesChanged: 2,
			linesAdded: 0,
			linesRemoved: 5,
		});
	});

	it("treats a missing deletions clause as zero", () => {
		expect(parseShortstat(" 1 file changed, 10 insertions(+)\n")).toEqual({
			filesChanged: 1,
			linesAdded: 10,
			linesRemoved: 0,
		});
	});

	it("handles the singular 'file changed' / 'insertion' / 'deletion' forms", () => {
		expect(
			parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)\n"),
		).toEqual({ filesChanged: 1, linesAdded: 1, linesRemoved: 1 });
	});

	it("returns zeros for empty output", () => {
		expect(parseShortstat("")).toEqual({
			filesChanged: 0,
			linesAdded: 0,
			linesRemoved: 0,
		});
	});
});
