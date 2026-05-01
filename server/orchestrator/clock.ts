export type Clock = {
	now(): number;
};

export function systemClock(): Clock {
	return {
		now: () => Date.now(),
	};
}
