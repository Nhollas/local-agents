export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"scope-empty": [0], // scope is optional
		"scope-enum": [2, "always", ["core", "dashboard", "docs"]],
	},
};
