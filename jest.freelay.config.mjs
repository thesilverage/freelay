// Public Freelay tests are deliberately outside upstream's encrypted __tests__.
export default {
	testMatch: ["<rootDir>/tests/freelay/**/*.test.ts"],
	testEnvironment: "node",
	transform: {"\\.ts$": ["ts-jest", {isolatedModules: true, tsconfig: {target: "ES2022", module: "CommonJS", verbatimModuleSyntax: false, resolveJsonModule: true}}]},
};
