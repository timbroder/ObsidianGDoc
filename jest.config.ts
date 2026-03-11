import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^obsidian$": "<rootDir>/tests/mocks/obsidian-api.ts",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/main.ts",
    "!src/types.ts",
    "!src/constants.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
};

export default config;
