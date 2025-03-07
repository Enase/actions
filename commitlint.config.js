module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', ['deps', 'deps-dev', 'automatic-releases', 'keybase-notifications', 'global']],
    'footer-max-line-length': [0, 'never'],
    'body-max-line-length': [0, 'never'],
  },
  ignores: [
    (message) =>
      message.startsWith('chore(deps): ') ||
      [
        'Merge pull request',
        'Update Github Runner Node version and deprecate set-output',
        'Deprecation of aws-ssm-secrets and keybase-notifications packages',
      ].some((skipString) => message.includes(skipString)),
  ],
};
