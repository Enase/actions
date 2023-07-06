module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  testEnvironment: 'node',
  testRunner: 'jest-circus/runner',
  transform: {
    '^.+\\.ts$': 'babel-jest',
  },
  collectCoverage: true,
  projects: [
    {
      displayName: 'automatic-releases',
      testRegex: 'packages/automatic-releases/__tests__',
      testPathIgnorePatterns: ['/__tests__/payloads', '/__tests__/utils/', '/__tests__/assets'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    },
  ],
  coverageReporters: ['text'],
  coverageThreshold: {
    global: {
      lines: 100,
    },
  },
  collectCoverageFrom: [
    '**/packages/automatic-releases/**/*.ts',
    '!**/packages/automatic-releases/src/index.ts',
    '!**/packages/automatic-releases/src/uploadReleaseArtifacts.ts',
    '!**/__tests__/**',
    '!**/dist/**',
  ],
};
